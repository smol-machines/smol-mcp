// Orchestration above a backend: readiness, ephemeral naming, run-once.
import { randomBytes } from "node:crypto";
import type { MachineBackend, MachineView, NetworkPolicy } from "./backend.js";
import { BackendError } from "./backend.js";
import type { Config } from "./config.js";
import { shapeResult, toArgv } from "./output.js";
import type { CommandResult } from "./output.js";
import type { StateFile } from "./local/state.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The workload that keeps a local machine's container up. Without one, the
// image's own CMD is the workload; for an interpreter image it exits at once
// and the container relaunches, and an exec landing in the gap returns exit 1
// with empty output. The cloud target ignores it: exec there auto-starts a
// stopped machine, so there is nothing to keep alive.
export const KEEPALIVE_CMD = ["sh", "-c", "while true; do sleep 3600; done"];

export function ephemeralName(prefix: string, kind = ""): string {
  return `${prefix}${kind === "" ? "" : `${kind}-`}${randomBytes(4).toString("hex")}`;
}

// Wait until an exec in the workload container returns a value. This is the
// gate a file upload depends on: a file uploaded before the container runs is
// written into the agent's namespace and is not visible once the container
// mounts over the path.
export async function waitReady(
  backend: MachineBackend,
  name: string,
  timeoutSecs: number,
  now: () => number = Date.now,
  pause: (ms: number) => Promise<unknown> = sleep,
): Promise<{ attempts: number }> {
  const nonce = `READY-${randomBytes(4).toString("hex")}`;
  const deadline = now() + timeoutSecs * 1000;
  let attempts = 0;
  let last = "";
  for (;;) {
    attempts += 1;
    try {
      const r = await backend.exec(name, { command: ["echo", nonce], timeoutSecs: 10 }, 30_000);
      if (r.stdout.includes(nonce)) return { attempts };
      last = `exit ${r.exitCode}, stdout ${JSON.stringify(r.stdout)}, stderr ${JSON.stringify(r.stderr)}`;
    } catch (err) {
      if (err instanceof BackendError && err.code === "NOT_FOUND") throw err;
      last = err instanceof Error ? err.message : String(err);
    }
    if (now() >= deadline) {
      throw new BackendError(`machine ${name} did not become ready within ${timeoutSecs} s (last: ${last})`, "NOT_READY");
    }
    await pause(1000);
  }
}

export interface Machines {
  backend: MachineBackend;
  cfg: Config;
  state: StateFile | undefined;
}

export interface NetworkArgs {
  network?: "open" | "blocked" | undefined;
  allowHosts?: string[] | undefined;
  allowCidrs?: string[] | undefined;
}

// An allow-list beats the mode word: naming hosts and then asking for `open`
// would silently drop the list, and a dropped egress policy is the failure
// that is invisible until something reaches the internet.
export function networkPolicy(args: NetworkArgs, fallback: "open" | "blocked"): NetworkPolicy {
  const hosts = args.allowHosts ?? [];
  const cidrs = args.allowCidrs ?? [];
  if (hosts.length > 0 || cidrs.length > 0) return { mode: "allow", hosts, cidrs };
  return { mode: args.network ?? fallback };
}

export interface CreateArgs extends NetworkArgs {
  name?: string | undefined;
  image: string;
  cpus?: number | undefined;
  memoryMb?: number | undefined;
  cmd?: string[] | undefined;
  env?: Record<string, string> | undefined;
  start?: boolean | undefined;
}

export async function createMachine(m: Machines, args: CreateArgs) {
  const name = args.name ?? ephemeralName(m.cfg.machinePrefix);
  const ephemeral = name.startsWith(m.cfg.machinePrefix);
  const info = await m.backend.createMachine({
    name,
    image: args.image,
    cpus: args.cpus ?? m.cfg.cpus,
    memoryMb: args.memoryMb ?? m.cfg.memoryMb,
    network: networkPolicy(args, "open"),
    cmd: args.cmd ?? KEEPALIVE_CMD,
    ...(args.env ? { env: args.env } : {}),
    ...(ephemeral ? { ttlSeconds: m.cfg.ephemeralTtlSecs } : {}),
  });
  if (ephemeral) m.state?.add(name);
  let started = info;
  let ready = false;
  if (args.start ?? true) {
    started = await m.backend.startMachine(name);
    await waitReady(m.backend, name, m.cfg.readyTimeoutSecs);
    ready = true;
  }
  return { machine: started, ephemeral, ready };
}

export async function deleteMachine(m: Machines, name: string): Promise<string> {
  const r = await m.backend.deleteMachine(name);
  m.state?.remove(name);
  return r.deleted;
}

export interface RunArgs {
  command: string | string[];
  timeoutSecs?: number | undefined;
  workdir?: string | undefined;
  env?: Record<string, string> | undefined;
  stdin?: string | undefined;
}

export async function runCommand(m: Machines, name: string, args: RunArgs): Promise<CommandResult> {
  const timeoutSecs = args.timeoutSecs ?? m.cfg.execTimeoutSecs;
  const r = await m.backend.exec(
    name,
    {
      command: toArgv(args.command),
      timeoutSecs,
      ...(args.workdir !== undefined ? { workdir: args.workdir } : {}),
      ...(args.env ? { env: args.env } : {}),
      ...(args.stdin !== undefined ? { stdin: args.stdin } : {}),
    },
    // Client-side backstop past the server-side timeout.
    (timeoutSecs + 30) * 1000,
  );
  return shapeResult(r, m.cfg.maxOutputBytes);
}

export interface RunOnceArgs extends RunArgs, NetworkArgs {
  image: string;
  cpus?: number | undefined;
  memoryMb?: number | undefined;
}

// The plain path only: create, start, exec, delete. Never the OCI cache or
// init paths (smol-machines/smolvm#1192 and #1193). Delete runs whatever
// happened above it, so a timeout or a thrown error still removes the machine.
export async function runOnce(m: Machines, args: RunOnceArgs): Promise<CommandResult & { machine: string }> {
  const name = ephemeralName(m.cfg.machinePrefix, "once");
  m.state?.add(name);
  const fallback = m.backend.target === "cloud" ? "blocked" : (m.cfg.runOnceNetwork as "open" | "blocked");
  let result: CommandResult | undefined;
  let failure: unknown;
  try {
    await m.backend.createMachine({
      name,
      image: args.image,
      cpus: args.cpus ?? m.cfg.cpus,
      memoryMb: args.memoryMb ?? m.cfg.memoryMb,
      network: networkPolicy(args, fallback),
      cmd: KEEPALIVE_CMD,
      ttlSeconds: m.cfg.ephemeralTtlSecs,
    });
    await m.backend.startMachine(name);
    await waitReady(m.backend, name, m.cfg.readyTimeoutSecs);
    result = await runCommand(m, name, args);
  } catch (err) {
    failure = err;
  }
  // Delete on every path, then report the original failure over a delete
  // failure. A machine that never got created returns NOT_FOUND here.
  try {
    await m.backend.deleteMachine(name);
  } catch (err) {
    if (!(err instanceof BackendError && err.code === "NOT_FOUND")) failure ??= err;
  }
  m.state?.remove(name);
  if (failure !== undefined) throw failure;
  return { ...(result as CommandResult), machine: name };
}

export async function writeFile(m: Machines, name: string, path: string, content: Buffer) {
  // Readiness first: see waitReady.
  await waitReady(m.backend, name, m.cfg.readyTimeoutSecs);
  return m.backend.writeFile(name, path, content);
}

// Delete every ephemeral machine recorded for this process (and for dead
// ones). Errors are collected, not thrown: cleanup runs on the way out.
export async function cleanupEphemeral(m: Machines): Promise<{ deleted: string[]; failed: { name: string; error: string }[] }> {
  const deleted: string[] = [];
  const failed: { name: string; error: string }[] = [];
  if (!m.state) return { deleted, failed };
  for (const name of m.state.owned()) {
    if (!name.startsWith(m.cfg.machinePrefix)) continue;
    try {
      await m.backend.deleteMachine(name);
      deleted.push(name);
      m.state.remove(name);
    } catch (err) {
      if (err instanceof BackendError && err.code === "NOT_FOUND") {
        m.state.remove(name);
        continue;
      }
      failed.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { deleted, failed };
}

export type { MachineView };
