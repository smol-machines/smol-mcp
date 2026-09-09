// Builds the McpServer, wires the two backends, and runs cleanup on close.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { MachineBackend, MachineView } from "./backend.js";
import { BackendError } from "./backend.js";
import { CloudClient } from "./cloud/client.js";
import type { Config, TargetMode } from "./config.js";
import { resolveTargets } from "./config.js";
import { StateFile } from "./local/state.js";
import { ensureServe } from "./local/serve.js";
import type { ServeHandle } from "./local/serve.js";
import * as ops from "./machines.js";
import type { Machines } from "./machines.js";
import { TARGETS_URI, serverInstructions, targetInfos } from "./targets.js";
import { commandResultOutput, machineOutput, toolDescriptions, toolInputs } from "./tools.js";
import type { ToolName } from "./tools.js";

export const SERVER_VERSION = "0.1.0";

export interface SmolMcp {
  server: McpServer;
  // The targets this process was started to reach.
  mode: TargetMode;
  // Resolving this starts `smolvm serve` if nothing is already listening.
  local(): Promise<Machines>;
  cloud: Machines;
  serve(): Promise<ServeHandle>;
  shutdown(): Promise<{ deleted: string[]; failed: { name: string; error: string }[] }>;
}

function ok(structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof BackendError ? err.code : "ERROR";
  return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
}

function machineView(m: MachineView) {
  return { id: m.id, name: m.name, state: m.state, cpus: m.cpus, memoryMb: m.memoryMb, network: m.network, createdAt: m.createdAt, image: m.image, pid: m.pid };
}

export interface CreateServerOptions {
  cfg: Config;
  log?: (msg: string) => void;
  // Test seam: a backend in place of a real serve.
  localBackend?: MachineBackend;
}

export async function createServer(opts: CreateServerOptions): Promise<SmolMcp> {
  const { cfg } = opts;
  const mode = resolveTargets(cfg);
  const log = opts.log ?? ((msg: string) => process.stderr.write(`smol-mcp: ${msg}\n`));
  const state = StateFile.inRuntimeDir(cfg.runtimeDir);

  // The serve is started on the first local call, not at connect. A client
  // that only ever names the cloud target must not need smolvm installed,
  // and starting a hypervisor to answer a cloud list is the kind of side
  // effect that goes unnoticed until it fails on a machine without one.
  let started: Promise<{ serve: ServeHandle; machines: Machines }> | undefined;
  const serve = () => {
    started ??= (async () => {
      const handle: ServeHandle = opts.localBackend
        ? { client: opts.localBackend as never, url: "test", owned: false, version: "test", stop: async () => {} }
        : await ensureServe(cfg, log);
      const machines: Machines = { backend: opts.localBackend ?? handle.client, cfg, state };
      // Machines a crashed earlier instance left behind.
      const stale = await ops.cleanupEphemeral(machines);
      if (stale.deleted.length > 0) log(`deleted ${stale.deleted.length} stale ephemeral machine(s): ${stale.deleted.join(", ")}`);
      return { serve: handle, machines };
    })();
    return started;
  };
  const local = async () => (await serve()).machines;

  // The cloud target keeps no state file: ttlSeconds on the create is the
  // control plane's own backstop, and it survives this process being killed.
  const cloud: Machines = { backend: new CloudClient(cfg.cloudUrl, cfg.cloudToken), cfg, state: undefined };

  // Set once, when a client with elicitation answers which fleet this session
  // is for. From then on the argument is gone from every schema and this is
  // the answer for every call.
  let sessionTarget: "local" | "cloud" | undefined;

  // In a single-target mode there is no argument to read: the mode decides,
  // and an argument a client sent anyway was stripped by the schema.
  const chooseTarget = (arg: "local" | "cloud" | undefined): "local" | "cloud" => {
    if (mode !== "both") return mode;
    const chosen = arg ?? sessionTarget;
    if (chosen !== undefined) return chosen;
    throw new BackendError("this server reaches both fleets, so every call has to name target as local or cloud", "TARGET_REQUIRED");
  };
  const pick = async (target: "local" | "cloud" | undefined) => {
    await askTargetOnce();
    return chooseTarget(target) === "cloud" ? cloud : await local();
  };

  // The instructions are the only place an agent learns which fleets this
  // process reaches before it calls anything.
  const server = new McpServer({ name: "smol-mcp", version: SERVER_VERSION }, { instructions: serverInstructions(mode, cfg) });
  const inputs = toolInputs(mode);
  const registered = {} as Record<ToolName, RegisteredTool>;

  server.registerResource(
    "targets",
    TARGETS_URI,
    {
      title: "Targets this server reaches",
      description: "Which fleets this process serves, whether each one is usable on this host, and what each cannot do.",
      mimeType: "application/json",
    },
    (uri) => {
      const body = { mode, sessionTarget: sessionTarget ?? null, targets: targetInfos(mode, cfg) };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
    },
  );

  registered["list-machines"] = server.registerTool("list-machines", { description: toolDescriptions["list-machines"], inputSchema: inputs["list-machines"], outputSchema: { machines: z.array(z.object(machineOutput)) } }, async (a) => {
    try {
      const list = await (await pick(a.target)).backend.listMachines();
      return ok({ machines: list.map(machineView) });
    } catch (err) {
      return fail(err);
    }
  });

  registered["get-machine"] = server.registerTool("get-machine", { description: toolDescriptions["get-machine"], inputSchema: inputs["get-machine"], outputSchema: machineOutput }, async (a) => {
    try {
      return ok(machineView(await (await pick(a.target)).backend.getMachine(a.name)));
    } catch (err) {
      return fail(err);
    }
  });

  registered["create-machine"] = server.registerTool("create-machine", { description: toolDescriptions["create-machine"], inputSchema: inputs["create-machine"], outputSchema: { machine: z.object(machineOutput), ephemeral: z.boolean(), ready: z.boolean() } }, async (a) => {
    try {
      const r = await ops.createMachine((await pick(a.target)), a);
      return ok({ machine: machineView(r.machine), ephemeral: r.ephemeral, ready: r.ready });
    } catch (err) {
      return fail(err);
    }
  });

  registered["run-command"] = server.registerTool("run-command", { description: toolDescriptions["run-command"], inputSchema: inputs["run-command"], outputSchema: commandResultOutput }, async (a) => {
    try {
      return ok({ ...(await ops.runCommand((await pick(a.target)), a.name, a)) });
    } catch (err) {
      return fail(err);
    }
  });

  registered["run-once"] = server.registerTool("run-once", { description: toolDescriptions["run-once"], inputSchema: inputs["run-once"], outputSchema: { ...commandResultOutput, machine: z.string() } }, async (a) => {
    try {
      return ok({ ...(await ops.runOnce((await pick(a.target)), a)) });
    } catch (err) {
      return fail(err);
    }
  });

  registered["read-file"] = server.registerTool("read-file", { description: toolDescriptions["read-file"], inputSchema: inputs["read-file"], outputSchema: { path: z.string(), content: z.string(), encoding: z.string(), size: z.number() } }, async (a) => {
    try {
      const buf = await (await pick(a.target)).backend.readFile(a.name, a.path);
      return ok({ path: a.path, content: buf.toString(a.encoding), encoding: a.encoding, size: buf.length });
    } catch (err) {
      return fail(err);
    }
  });

  registered["write-file"] = server.registerTool("write-file", { description: toolDescriptions["write-file"], inputSchema: inputs["write-file"], outputSchema: { path: z.string(), size: z.number() } }, async (a) => {
    try {
      const r = await ops.writeFile((await pick(a.target)), a.name, a.path, Buffer.from(a.content, a.encoding));
      return ok({ path: r.path, size: r.size });
    } catch (err) {
      return fail(err);
    }
  });

  registered["stop-machine"] = server.registerTool("stop-machine", { description: toolDescriptions["stop-machine"], inputSchema: inputs["stop-machine"], outputSchema: machineOutput }, async (a) => {
    try {
      return ok(machineView(await (await pick(a.target)).backend.stopMachine(a.name)));
    } catch (err) {
      return fail(err);
    }
  });

  registered["delete-machine"] = server.registerTool("delete-machine", { description: toolDescriptions["delete-machine"], inputSchema: inputs["delete-machine"], outputSchema: { deleted: z.string() } }, async (a) => {
    try {
      return ok({ deleted: await ops.deleteMachine((await pick(a.target)), a.name) });
    } catch (err) {
      return fail(err);
    }
  });

  registered["machine-logs"] = server.registerTool("machine-logs", { description: toolDescriptions["machine-logs"], inputSchema: inputs["machine-logs"], outputSchema: { lines: z.array(z.string()) } }, async (a) => {
    try {
      return ok({ lines: await (await pick(a.target)).backend.logs(a.name, a.tail ?? cfg.logsTail) });
    } catch (err) {
      return fail(err);
    }
  });

  registered["pull-image"] = server.registerTool("pull-image", { description: toolDescriptions["pull-image"], inputSchema: inputs["pull-image"], outputSchema: { reference: z.string(), digest: z.string(), size: z.number(), architecture: z.string(), os: z.string(), layerCount: z.number() } }, async (a) => {
    try {
      const img = await (await pick(a.target)).backend.pullImage(a.name, a.image);
      return ok({ reference: img.reference, digest: img.digest, size: img.size, architecture: img.architecture, os: img.os, layerCount: img.layerCount });
    } catch (err) {
      return fail(err);
    }
  });

  // Elicitation is a client capability, so this runs at most once and every
  // way of not getting an answer (no capability, a decline, a cancel, a
  // timeout, a client that answers "both") leaves the argument required.
  let asked: Promise<void> | undefined;
  const askTargetOnce = () => {
    if (mode !== "both") return Promise.resolve();
    asked ??= (async () => {
      if (server.server.getClientCapabilities()?.elicitation === undefined) return;
      let answer: string | undefined;
      try {
        const res = await server.server.elicitInput({
          message: "This server reaches both the local fleet (smolvm serve on this host) and the smol cloud fleet. Which should this session use? Answering local or cloud removes the target argument from every tool.",
          requestedSchema: {
            type: "object",
            properties: {
              target: {
                type: "string",
                title: "Target fleet",
                description: "local, cloud, or both to keep naming it per call",
                enum: ["local", "cloud", "both"],
              },
            },
            required: ["target"],
          },
        });
        if (res.action === "accept") answer = typeof res.content?.target === "string" ? res.content.target : undefined;
      } catch (err) {
        log(`target elicitation failed, keeping the target argument required: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (answer !== "local" && answer !== "cloud") return;
      sessionTarget = answer;
      // Narrowing the session narrows the schemas: the SDK sends one
      // tools/listChanged for the batch.
      const narrowed = toolInputs(answer);
      for (const name of Object.keys(registered) as ToolName[]) {
        registered[name].update({ paramsSchema: narrowed[name] });
      }
      log(`session target elicited: ${answer}; the target argument is now off every tool`);
    })();
    return asked;
  };

  let shutdownOnce: Promise<{ deleted: string[]; failed: { name: string; error: string }[] }> | undefined;
  const shutdown = () => {
    shutdownOnce ??= (async () => {
      // Nothing local ever ran: there is no serve to stop and no machine of
      // ours to delete, and starting one now to find that out would be absurd.
      if (started === undefined) return { deleted: [], failed: [] };
      // A serve that failed to start owns no machine and no process, so there
      // is nothing here to clean up and nothing to report. The call that
      // provoked the failure already returned it; repeating it on the way out
      // reads as a second, unrelated fault.
      let ran: { serve: ServeHandle; machines: Machines };
      try {
        ran = await started;
      } catch {
        return { deleted: [], failed: [] };
      }
      const { serve: handle, machines } = ran;
      // Machines first: stopping the serve orphans anything still running.
      const result = await ops.cleanupEphemeral(machines);
      if (result.deleted.length > 0) log(`deleted ephemeral machine(s): ${result.deleted.join(", ")}`);
      for (const f of result.failed) log(`failed to delete ${f.name}: ${f.error}`);
      await handle.stop();
      return result;
    })();
    return shutdownOnce;
  };

  return { server, mode, local, cloud, serve: async () => (await serve()).serve, shutdown };
}
