// Orchestration above a backend: readiness, ephemeral naming, run-once.
import { randomBytes } from "node:crypto";
import type { CallCtx, MachineBackend, MachineView, MountSpec, NetworkPolicy, PortSpec } from "./backend.js";
import { BackendError } from "./backend.js";
import type { Config } from "./config.js";
import { shapeResult, toArgv } from "./output.js";
import type { CommandResult } from "./output.js";

// What a target needs to remember about the machines a session created. The
// local target keeps a file, because a crashed process has to be cleaned up
// by the next one; the cloud target keeps a list in memory, because its API
// remembers nothing for us and its own backstops cover a process that dies.
export interface EphemeralStore {
  add(name: string, owner: string, id?: string): void;
  remove(name: string): void;
  owned(owner: string): { name: string; id: string }[];
}

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
  ctx: CallCtx = {},
): Promise<{ attempts: number }> {
  const nonce = `READY-${randomBytes(4).toString("hex")}`;
  const deadline = now() + timeoutSecs * 1000;
  let attempts = 0;
  let last = "";
  for (;;) {
    attempts += 1;
    try {
      ctx.signal?.throwIfAborted();
      const r = await backend.exec(name, { command: ["echo", nonce], timeoutSecs: 10 }, 30_000, ctx);
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
  state: EphemeralStore | undefined;
  // The session that owns what this record creates. One process can host
  // many, and each cleans up only its own.
  session: string;
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
  ports?: PortSpec[] | undefined;
  mounts?: MountSpec[] | undefined;
  storageGb?: number | undefined;
  overlayGb?: number | undefined;
  cmd?: string[] | undefined;
  env?: Record<string, string> | undefined;
  start?: boolean | undefined;
}

export async function createMachine(m: Machines, args: CreateArgs, ctx: CallCtx = {}) {
  const name = args.name ?? ephemeralName(m.cfg.machinePrefix);
  const ephemeral = name.startsWith(m.cfg.machinePrefix);
  const info = await m.backend.createMachine({
    name,
    image: args.image,
    cpus: args.cpus ?? m.cfg.cpus,
    memoryMb: args.memoryMb ?? m.cfg.memoryMb,
    network: networkPolicy(args, "open"),
    ...(args.ports ? { ports: args.ports } : {}),
    ...(args.mounts ? { mounts: args.mounts } : {}),
    ...(args.storageGb !== undefined ? { storageGb: args.storageGb } : {}),
    ...(args.overlayGb !== undefined ? { overlayGb: args.overlayGb } : {}),
    cmd: args.cmd ?? KEEPALIVE_CMD,
    ...(args.env ? { env: args.env } : {}),
    ...(ephemeral ? { ttlSeconds: m.cfg.ephemeralTtlSecs } : {}),
  }, ctx);
  if (ephemeral) m.state?.add(name, m.session, info.id);
  let started = info;
  let ready = false;
  if (args.start ?? true) {
    started = await m.backend.startMachine(name, ctx);
    await waitReady(m.backend, name, m.cfg.readyTimeoutSecs, Date.now, sleep, ctx);
    ready = true;
  }
  return { machine: started, ephemeral, ready };
}

export async function deleteMachine(m: Machines, name: string, ctx: CallCtx = {}): Promise<string> {
  const r = await m.backend.deleteMachine(name, ctx);
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

export async function runCommand(m: Machines, name: string, args: RunArgs, ctx: CallCtx = {}): Promise<CommandResult> {
  const timeoutSecs = args.timeoutSecs ?? m.cfg.execTimeoutSecs;
  // A tool call holds a machine, and on the cloud target a bill, for as long
  // as it runs. Without a ceiling the caller sets that duration and nothing
  // else does.
  if (timeoutSecs > m.cfg.maxExecTimeoutSecs) {
    throw new BackendError(`timeoutSecs ${timeoutSecs} is above this server's ceiling of ${m.cfg.maxExecTimeoutSecs} s`, "TIMEOUT_TOO_LONG");
  }
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
    ctx,
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
export async function runOnce(m: Machines, args: RunOnceArgs, ctx: CallCtx = {}): Promise<CommandResult & { machine: string }> {
  const name = ephemeralName(m.cfg.machinePrefix, "once");
  m.state?.add(name, m.session);
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
    }, ctx);
    await m.backend.startMachine(name, ctx);
    await waitReady(m.backend, name, m.cfg.readyTimeoutSecs, Date.now, sleep, ctx);
    result = await runCommand(m, name, args, ctx);
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

export async function writeFile(m: Machines, name: string, path: string, content: Buffer, ctx: CallCtx = {}) {
  // Readiness first: see waitReady.
  await waitReady(m.backend, name, m.cfg.readyTimeoutSecs, Date.now, sleep, ctx);
  return m.backend.writeFile(name, path, content, ctx);
}

// Delete every ephemeral machine recorded for this process (and for dead
// ones). Errors are collected, not thrown: cleanup runs on the way out.
export async function cleanupEphemeral(m: Machines): Promise<{ deleted: string[]; failed: { name: string; error: string }[] }> {
  const deleted: string[] = [];
  const failed: { name: string; error: string }[] = [];
  if (!m.state) return { deleted, failed };
  let owned: { name: string; id: string }[];
  try {
    owned = m.state.owned(m.session);
  } catch (err) {
    // Reported, not swallowed: an unreadable record means machines may be
    // running that nothing here can name.
    return { deleted, failed: [{ name: "(the machine record)", error: err instanceof Error ? err.message : String(err) }] };
  }
  for (const { name, id } of owned) {
    // The prefix is checked on the name, never on the id: the id is whatever
    // the backend's delete route takes and carries no such marker.
    if (!name.startsWith(m.cfg.machinePrefix)) continue;
    try {
      await m.backend.deleteMachine(id);
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
