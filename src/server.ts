// Builds the McpServer, wires the two backends, and runs cleanup on close.
import { randomUUID } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CallCtx, MachineBackend, MachineView } from "./backend.js";
import { BackendError } from "./backend.js";
import { CloudClient } from "./cloud/client.js";
import type { Config, TargetMode } from "./config.js";
import { resolveTargets } from "./config.js";
import { StateFile } from "./local/state.js";
import { MemoryStore } from "./memory-state.js";
import { ensureServe, serveKey } from "./local/serve.js";
import { serves } from "./local/pool.js";
import type { ServeHandle } from "./local/serve.js";
import * as ops from "./machines.js";
import type { Machines } from "./machines.js";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type { Overflow } from "./output.js";
import { TARGETS_URI, serverInstructions, targetInfos } from "./targets.js";
import { commandResultOutput, machineOutput, toolDescriptions, toolInputs } from "./tools.js";
import type { ToolName } from "./tools.js";

export const SERVER_VERSION = "0.1.0";

export const LOGS_URI_TEMPLATE = "smol://machine/{target}/{name}/logs";

export function logsUri(target: string, name: string): string {
  return new UriTemplate(LOGS_URI_TEMPLATE).expand({ target, name });
}

// The target out of a matched URI. A template variable is a string or a list
// of them, and only one of the two values names a fleet.
function targetOf(vars: Record<string, unknown>): "local" | "cloud" {
  return String(vars.target) === "cloud" ? "cloud" : "local";
}

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

export const FILE_URI_TEMPLATE = "smol://machine/{target}/{name}/file{+path}";

export function fileUri(target: string, name: string, path: string): string {
  return new UriTemplate(FILE_URI_TEMPLATE).expand({ target, name, path });
}

// One link per spilled stream, alongside the text, never instead of it.
function overflowLinks(target: string, name: string, overflow: Overflow[]): CallToolResult["content"] {
  return overflow.map((o) => ({
    type: "resource_link" as const,
    uri: fileUri(target, name, o.path),
    name: o.path,
    mimeType: "text/plain",
    description: `the whole ${o.stream} of this command, ${o.bytes} bytes, in machine ${name}`,
  }));
}

function ok(structured: Record<string, unknown>, extra: CallToolResult["content"] = []): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured, null, 2) }, ...extra], structuredContent: structured };
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof BackendError ? err.code : "ERROR";
  return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
}

// The SDK hands every handler an abort signal that fires on the client's
// notifications/cancelled. Reading it is what makes a cancel release the
// machine and, on the cloud target, stop the bill.
function ctxOf(extra: { signal?: AbortSignal }): CallCtx {
  return { signal: extra.signal };
}

function machineView(m: MachineView) {
  return { id: m.id, name: m.name, state: m.state, cpus: m.cpus, memoryMb: m.memoryMb, network: m.network, createdAt: m.createdAt, image: m.image, pid: m.pid };
}

export interface CreateServerOptions {
  cfg: Config;
  log?: (msg: string) => void;
  // Test seam: a backend in place of a real serve.
  localBackend?: MachineBackend;
  // Test seam: a backend in place of the real cloud API.
  cloudBackend?: MachineBackend;
  // Identity of the session this server belongs to. Generated when absent.
  session?: string;
}

export async function createServer(opts: CreateServerOptions): Promise<SmolMcp> {
  const { cfg } = opts;
  const mode = resolveTargets(cfg);
  const log = opts.log ?? ((msg: string) => process.stderr.write(`smol-mcp: ${msg}\n`));
  const state = StateFile.inRuntimeDir(cfg.runtimeDir);
  // One process can host many sessions, and a session is the unit that owns
  // an ephemeral machine and cleans it up.
  const session = opts.session ?? randomUUID();

  // The serve is started on the first local call, not at connect. A client
  // that only ever names the cloud target must not need smolvm installed,
  // and starting a hypervisor to answer a cloud list is the kind of side
  // effect that goes unnoticed until it fails on a machine without one.
  let started: Promise<{ serve: ServeHandle; machines: Machines }> | undefined;
  const serve = () => {
    started ??= (async () => {
      const handle: ServeHandle = opts.localBackend
        ? { client: opts.localBackend as never, url: "test", owned: false, version: "test", stop: async () => {} }
        : await serves.acquire(serveKey(cfg), () => ensureServe(cfg, log));
      const machines: Machines = { backend: opts.localBackend ?? handle.client, cfg, state, session };
      // Machines a crashed earlier instance left behind.
      const stale = await ops.cleanupEphemeral(machines);
      if (stale.deleted.length > 0) log(`deleted ${stale.deleted.length} stale ephemeral machine(s): ${stale.deleted.join(", ")}`);
      return { serve: handle, machines };
    })();
    return started;
  };
  const local = async () => (await serve()).machines;

  // The cloud target keeps its record in memory rather than in the runtime
  // directory: the machines are not this host's, so nothing on this host has
  // to clean them up after a crash, and the control plane's own ttlSeconds
  // covers that case. What it does need is a record at all, so the session
  // that created them deletes them when it ends.
  const cloudState = new MemoryStore();
  const cloud: Machines = { backend: opts.cloudBackend ?? new CloudClient(cfg.cloudUrl, cfg.cloudToken), cfg, state: cloudState, session };

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

  // A file inside a machine, addressable. It exists so an oversized command
  // result can hand back a link to the whole output rather than only a path
  // in prose: a client that reads resources fetches it through this same
  // server, and one that does not still has the path, which is why the link
  // is never the only place the fact appears.
  server.registerResource(
    "machine-file",
    new ResourceTemplate(FILE_URI_TEMPLATE, { list: undefined }),
    { title: "A file inside a machine", description: "Read a file out of a machine on either target." },
    async (uri, vars) => {
      const target = String(vars.target) === "cloud" ? "cloud" : "local";
      const path = String(vars.path);
      const buf = await (await pick(target)).backend.readFile(String(vars.name), path);
      return { contents: [{ uri: uri.href, mimeType: "application/octet-stream", text: buf.toString("utf8") }] };
    },
  );

  // A machine's log as a resource, and following it as a subscription to
  // that resource. Neither log route pushes, so the following is a poll on
  // this side; what the client sees is the shape it already has for a thing
  // that changes, rather than a tool it has to call in a loop.
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.registerResource(
    "machine-logs",
    new ResourceTemplate(LOGS_URI_TEMPLATE, { list: undefined }),
    { title: "A machine's log", description: "The tail of a machine's log. Subscribe to be told when there is more.", mimeType: "text/plain" },
    async (uri, vars) => {
      const page = await ops.logs(await pick(targetOf(vars)), String(vars.name), {});
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: page.lines.join("\n") }] };
    },
  );

  // One poll per subscribed machine, cleared when the last subscriber goes
  // and when the connection closes; a timer left running holds a machine
  // reference and, on the cloud target, keeps paying for calls nobody reads.
  const followers = new Map<string, { timer: NodeJS.Timeout; cursor: string }>();
  const stopFollowing = (uri: string) => {
    const f = followers.get(uri);
    if (f === undefined) return;
    clearInterval(f.timer);
    followers.delete(uri);
  };
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    const uri = req.params.uri;
    const vars = new UriTemplate(LOGS_URI_TEMPLATE).match(uri);
    if (vars === null) throw new BackendError(`${uri} is not a machine log resource`, "NOT_SUBSCRIBABLE");
    if (followers.has(uri)) return {};
    const machines = await pick(targetOf(vars));
    const name = String(vars.name);
    const first = await ops.logs(machines, name, {});
    const timer = setInterval(() => {
      void (async () => {
        const held = followers.get(uri);
        if (held === undefined) return;
        try {
          const page = await ops.logs(machines, name, { cursor: held.cursor });
          held.cursor = page.cursor;
          if (page.lines.length > 0) await server.server.sendResourceUpdated({ uri });
        } catch (err) {
          // A machine that went away is not a reason to keep polling it.
          log(`stopped following ${uri}: ${err instanceof Error ? err.message : String(err)}`);
          stopFollowing(uri);
        }
      })();
    }, cfg.logsPollSecs * 1000);
    // The poll must not be the reason this process stays alive.
    timer.unref?.();
    followers.set(uri, { timer, cursor: first.cursor });
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, (req) => {
    stopFollowing(req.params.uri);
    return {};
  });

  registered["list-machines"] = server.registerTool("list-machines", { description: toolDescriptions["list-machines"], inputSchema: inputs["list-machines"], outputSchema: { machines: z.array(z.object(machineOutput)) } }, async (a, extra) => {
    try {
      const list = await (await pick(a.target)).backend.listMachines(ctxOf(extra));
      return ok({ machines: list.map(machineView) });
    } catch (err) {
      return fail(err);
    }
  });

  registered["get-machine"] = server.registerTool("get-machine", { description: toolDescriptions["get-machine"], inputSchema: inputs["get-machine"], outputSchema: machineOutput }, async (a, extra) => {
    try {
      return ok(machineView(await (await pick(a.target)).backend.getMachine(a.name, ctxOf(extra))));
    } catch (err) {
      return fail(err);
    }
  });

  registered["create-machine"] = server.registerTool("create-machine", { description: toolDescriptions["create-machine"], inputSchema: inputs["create-machine"], outputSchema: { machine: z.object(machineOutput), ephemeral: z.boolean(), ready: z.boolean() } }, async (a, extra) => {
    try {
      const r = await ops.createMachine(await pick(a.target), a, ctxOf(extra));
      return ok({ machine: machineView(r.machine), ephemeral: r.ephemeral, ready: r.ready });
    } catch (err) {
      return fail(err);
    }
  });

  registered["run-command"] = server.registerTool("run-command", { description: toolDescriptions["run-command"], inputSchema: inputs["run-command"], outputSchema: { ...commandResultOutput, startedMachine: z.boolean() } }, async (a, extra) => {
    try {
      const r = await ops.runCommandOnMachine(await pick(a.target), a.name, a, ctxOf(extra));
      return ok({ ...r }, overflowLinks(chooseTarget(a.target), a.name, r.overflow));
    } catch (err) {
      return fail(err);
    }
  });

  registered["run-once"] = server.registerTool("run-once", { description: toolDescriptions["run-once"], inputSchema: inputs["run-once"], outputSchema: { ...commandResultOutput, machine: z.string() } }, async (a, extra) => {
    try {
      return ok({ ...(await ops.runOnce(await pick(a.target), a, ctxOf(extra))) });
    } catch (err) {
      return fail(err);
    }
  });

  registered["read-file"] = server.registerTool("read-file", { description: toolDescriptions["read-file"], inputSchema: inputs["read-file"], outputSchema: { path: z.string(), content: z.string(), encoding: z.string(), size: z.number(), offset: z.number(), bytes: z.number(), eof: z.boolean(), startedMachine: z.boolean() } }, async (a, extra) => {
    try {
      const r = await ops.readFile(await pick(a.target), a.name, a.path, a, ctxOf(extra));
      return ok({ path: a.path, content: r.content.toString(a.encoding), encoding: a.encoding, size: r.size, offset: r.offset, bytes: r.content.length, eof: r.eof, startedMachine: r.startedMachine });
    } catch (err) {
      return fail(err);
    }
  });

  registered["write-file"] = server.registerTool("write-file", { description: toolDescriptions["write-file"], inputSchema: inputs["write-file"], outputSchema: { path: z.string(), size: z.number(), startedMachine: z.boolean() } }, async (a, extra) => {
    try {
      const r = await ops.writeFile(await pick(a.target), a.name, a.path, Buffer.from(a.content, a.encoding), ctxOf(extra));
      return ok({ path: r.path, size: r.size, startedMachine: r.startedMachine });
    } catch (err) {
      return fail(err);
    }
  });

  registered["start-machine"] = server.registerTool("start-machine", { description: toolDescriptions["start-machine"], inputSchema: inputs["start-machine"], outputSchema: { machine: z.object(machineOutput), ready: z.boolean() } }, async (a, extra) => {
    try {
      const r = await ops.startMachine(await pick(a.target), a.name, a.wait ?? true, ctxOf(extra));
      return ok({ machine: machineView(r.machine), ready: r.ready });
    } catch (err) {
      return fail(err);
    }
  });

  registered["branch-machine"] = server.registerTool("branch-machine", { description: toolDescriptions["branch-machine"], inputSchema: inputs["branch-machine"], outputSchema: { machine: z.object(machineOutput), ready: z.boolean() } }, async (a, extra) => {
    try {
      const r = await ops.branchMachine(await pick(a.target), a.name, a.childName, a.wait ?? true, ctxOf(extra));
      return ok({ machine: machineView(r.machine), ready: r.ready });
    } catch (err) {
      return fail(err);
    }
  });

  registered["stop-machine"] = server.registerTool("stop-machine", { description: toolDescriptions["stop-machine"], inputSchema: inputs["stop-machine"], outputSchema: machineOutput }, async (a, extra) => {
    try {
      return ok(machineView(await (await pick(a.target)).backend.stopMachine(a.name, ctxOf(extra))));
    } catch (err) {
      return fail(err);
    }
  });

  registered["delete-machine"] = server.registerTool("delete-machine", { description: toolDescriptions["delete-machine"], inputSchema: inputs["delete-machine"], outputSchema: { deleted: z.string() } }, async (a, extra) => {
    try {
      return ok({ deleted: await ops.deleteMachine(await pick(a.target), a.name, ctxOf(extra)) });
    } catch (err) {
      return fail(err);
    }
  });

  registered["machine-logs"] = server.registerTool("machine-logs", { description: toolDescriptions["machine-logs"], inputSchema: inputs["machine-logs"], outputSchema: { lines: z.array(z.string()), cursor: z.string(), truncated: z.boolean() } }, async (a, extra) => {
    try {
      return ok({ ...(await ops.logs(await pick(a.target), a.name, a, ctxOf(extra))) });
    } catch (err) {
      return fail(err);
    }
  });

  registered["pull-image"] = server.registerTool("pull-image", { description: toolDescriptions["pull-image"], inputSchema: inputs["pull-image"], outputSchema: { reference: z.string(), digest: z.string(), size: z.number(), architecture: z.string(), os: z.string(), layerCount: z.number() } }, async (a, extra) => {
    try {
      const img = await (await pick(a.target)).backend.pullImage(a.name, a.image, ctxOf(extra));
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

  const previousClose = server.server.onclose;
  server.server.onclose = () => {
    for (const uri of [...followers.keys()]) stopFollowing(uri);
    previousClose?.();
  };

  let shutdownOnce: Promise<{ deleted: string[]; failed: { name: string; error: string }[] }> | undefined;
  const shutdown = () => {
    shutdownOnce ??= (async () => {
      // The cloud record first, and unconditionally: a session that only ever
      // used the cloud target has machines to delete and no serve to stop, and
      // it used to leave them running to their TTL. A session that created
      // none pays no call for this.
      const fromCloud = await ops.cleanupEphemeral(cloud);
      if (fromCloud.deleted.length > 0) log(`deleted cloud machine(s): ${fromCloud.deleted.join(", ")}`);
      for (const f of fromCloud.failed) log(`failed to delete ${f.name}: ${f.error}`);
      // Nothing local ever ran: there is no serve to stop and no machine of
      // ours to delete, and starting one now to find that out would be absurd.
      if (started === undefined) return fromCloud;
      // A serve that failed to start owns no machine and no process, so there
      // is nothing here to clean up and nothing to report. The call that
      // provoked the failure already returned it; repeating it on the way out
      // reads as a second, unrelated fault.
      let ran: { serve: ServeHandle; machines: Machines };
      try {
        ran = await started;
      } catch {
        return fromCloud;
      }
      const { serve: handle, machines } = ran;
      // Machines first: stopping the serve orphans anything still running.
      const result = await ops.cleanupEphemeral(machines);
      if (result.deleted.length > 0) log(`deleted ephemeral machine(s): ${result.deleted.join(", ")}`);
      for (const f of result.failed) log(`failed to delete ${f.name}: ${f.error}`);
      await handle.stop();
      return { deleted: [...fromCloud.deleted, ...result.deleted], failed: [...fromCloud.failed, ...result.failed] };
    })();
    return shutdownOnce;
  };

  return { server, mode, local, cloud, serve: async () => (await serve()).serve, shutdown };
}
