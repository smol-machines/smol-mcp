// Owns the `smolvm serve` process this server needs. Use an existing serve
// when one answers; otherwise start one in the runtime dir and stop it on
// exit. Only one serve can run per host (each binds 127.0.0.1:10081 for the
// guest rollout ingress), so a failed spawn names that cause.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants, createWriteStream, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { BackendError } from "../backend.js";
import type { Config } from "../config.js";
import { LocalClient } from "./client.js";
import { ensureRuntimeDir } from "./runtime-dir.js";

export interface ServeHandle {
  client: LocalClient;
  url: string;
  owned: boolean;
  version: string;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(url: string): Promise<string | undefined> {
  try {
    const h = await new LocalClient(url).health(2000);
    return h.status === "ok" ? h.version : undefined;
  } catch {
    return undefined;
  }
}

export function candidateUrls(cfg: Config, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (cfg.localUrl !== "") out.push(cfg.localUrl);
  out.push(`unix://${join(cfg.runtimeDir, "api.sock")}`);
  // smolvm's own defaults: XDG_RUNTIME_DIR on Linux, /tmp/smolvm.sock on macOS.
  if (env.XDG_RUNTIME_DIR) out.push(`unix://${join(env.XDG_RUNTIME_DIR, "smolvm.sock")}`);
  out.push("unix:///tmp/smolvm.sock");
  return [...new Set(out)];
}

// What the host would have to gain for the local target to work, or undefined
// if it already has it. Both checks are things no wait can change, so they run
// before the spawn: the honest answer to a local call inside a smol machine is
// an error on the first call, not a serve-start timeout minutes later.
export interface HostChecks {
  platform: string;
  exists: (path: string) => boolean;
  onPath: (bin: string) => boolean;
}

export const hostChecks: HostChecks = {
  platform: process.platform,
  exists: (path) => existsSync(path),
  onPath: (bin) =>
    (process.env.PATH ?? "").split(":").some((dir) => {
      if (dir === "") return false;
      try {
        accessSync(join(dir, bin), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
};

export function localUnavailable(cfg: Config, checks: HostChecks = hostChecks): string | undefined {
  const guest = 'a smol machine guest has neither, so use target "cloud" from inside one';
  // The hypervisor first: it is the check installing smolvm cannot satisfy.
  if (checks.platform === "linux" && !checks.exists("/dev/kvm")) {
    return `this host has no /dev/kvm, so it cannot start a virtual machine; ${guest}`;
  }
  const named = isAbsolute(cfg.smolvm) || cfg.smolvm.includes("/");
  if (named && !checks.exists(cfg.smolvm)) return `no smolvm binary at ${cfg.smolvm} (SMOLVM names it); ${guest}`;
  if (!named && !checks.onPath(cfg.smolvm)) return `'${cfg.smolvm}' is not on PATH, so no serve can be started; ${guest}`;
  return undefined;
}

// Two configurations that resolve to the same listen address share a serve;
// two that do not cannot, because the address is what a client dials.
export function serveKey(cfg: Config): string {
  return `${cfg.smolvm}|${cfg.localUrl}|${cfg.runtimeDir}`;
}

// The environment a hypervisor needs, and nothing else. An allow-list rather
// than a deny-list: a new secret in this process's environment must not reach
// the child by default just because nobody thought to name it here.
const SERVE_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"];

export function serveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of SERVE_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  // The binary's own settings travel; the tokens this server holds do not,
  // and neither does anything else that happens to be in the environment.
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("SMOLVM_") && value !== undefined) out[key] = value;
  }
  return out;
}

interface ServePid {
  // The serve child.
  pid: number;
  // The server process that started it. This is the half that decides whether
  // the serve is an orphan: a serve whose starter is still running belongs to
  // that starter, however many other instances find it listening.
  owner: number;
  url: string;
}

function readPidFile(path: string): ServePid | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.pid !== "number" || typeof rec.url !== "string") return undefined;
    // A file written before the owner was recorded cannot prove an orphan, so
    // it is read as "somebody else's".
    if (typeof rec.owner !== "number") return undefined;
    return { pid: rec.pid, owner: rec.owner, url: rec.url };
  } catch {
    return undefined;
  }
}

// An orphan is a serve that is still listening and whose starter is not. A
// serve started by a process that is still alive is in use, even when this
// process also wants it: taking it over would stop it under the other one,
// which is what a real run showed.
export function isOrphan(pid: ServePid | undefined, url: string, alive: (pid: number) => boolean = pidAlive): boolean {
  if (pid === undefined || pid.url !== url) return false;
  return alive(pid.pid) && !alive(pid.owner);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function ensureServe(cfg: Config, log: (msg: string) => void): Promise<ServeHandle> {
  ensureRuntimeDir(cfg.runtimeDir);

  // A serve left behind by an instance of this server that crashed is one to
  // reclaim, not one to leave running for the rest of the login session. The
  // pid file says which is which; a serve somebody else started is still
  // adopted read-only and left alone.
  const orphan = readPidFile(join(cfg.runtimeDir, "serve.pid"));
  for (const url of candidateUrls(cfg)) {
    const version = await probe(url);
    if (version === undefined) continue;
    const reclaimed = isOrphan(orphan, url);
    log(reclaimed ? `reclaiming the smolvm serve ${version} an earlier instance left at ${url} (pid ${orphan?.pid})` : `using existing smolvm serve ${version} at ${url}`);
    if (!reclaimed || orphan === undefined) return { client: new LocalClient(url), url, owned: false, version, stop: async () => {} };
    const pid = orphan.pid;
    return {
      client: new LocalClient(url),
      url,
      owned: true,
      version,
      stop: async () => {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Already gone, which is the outcome this was asking for.
        }
        rmSync(join(cfg.runtimeDir, "serve.pid"), { force: true });
      },
    };
  }

  // Nothing is listening, so this host has to run the serve itself.
  const missing = localUnavailable(cfg);
  if (missing !== undefined) throw new BackendError(`the local target is unavailable on this host: ${missing}`, "LOCAL_UNAVAILABLE");

  const url = cfg.localUrl !== "" ? cfg.localUrl : `unix://${join(cfg.runtimeDir, "api.sock")}`;
  const listen = url.startsWith("http://") ? url.slice("http://".length) : url;
  if (url.startsWith("http://") && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
    throw new Error(`refusing to start smolvm serve on a non-loopback address (${url}): the local API has no authentication`);
  }
  if (url.startsWith("unix://")) rmSync(url.slice("unix://".length), { force: true });

  const logPath = join(cfg.runtimeDir, "serve.log");
  const pidPath = join(cfg.runtimeDir, "serve.pid");
  const logStream = createWriteStream(logPath, { flags: "a" });
  let stderrTail = "";
  const child: ChildProcess = spawn(cfg.smolvm, ["serve", "start", "--listen", listen], {
    stdio: ["ignore", "pipe", "pipe"],
    // A minimal environment, because this child is a hypervisor and has no
    // use for either token: with the whole environment it carried both in a
    // process that never reads them, and a process environment is readable.
    env: serveEnv(process.env),
  });
  child.stdout?.on("data", (c: Buffer) => logStream.write(c));
  child.stderr?.on("data", (c: Buffer) => {
    logStream.write(c);
    stderrTail = (stderrTail + c.toString("utf8")).slice(-4000);
  });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exitPromise = new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      resolve();
    });
  });
  let spawnError: string | undefined;
  child.on("error", (err) => {
    spawnError = err.message;
    exited = { code: null, signal: null };
  });

  const deadline = Date.now() + cfg.serveStartTimeoutSecs * 1000;
  let version: string | undefined;
  while (Date.now() < deadline && exited === undefined) {
    version = await probe(url);
    if (version !== undefined) break;
    await sleep(250);
  }
  if (version === undefined) {
    child.kill("SIGKILL");
    if (spawnError !== undefined) {
      throw new BackendError(`could not run ${cfg.smolvm}: ${spawnError}. The local target needs smolvm and a hypervisor on this host; use target "cloud" where there is neither.`, "LOCAL_UNAVAILABLE");
    }
    const hint = stderrTail.includes("10081")
      ? " Another smolvm serve is already running on this host (only one can, it holds 127.0.0.1:10081); set SMOL_LOCAL_URL to its listen address."
      : "";
    // A serve that died in a second never waited the timeout, and saying it
    // did sends the reader to the wrong cause.
    const what = exited !== undefined ? `exited (code ${exited.code}, signal ${exited.signal}) without answering /health` : `did not answer /health within ${cfg.serveStartTimeoutSecs} s`;
    throw new Error(`smolvm serve ${what} (${cfg.smolvm} serve start --listen ${listen}).${hint} stderr: ${stderrTail.trim()}`);
  }
  // Who started this one, so a restart after a crash can tell a serve it
  // owns from one that was already here.
  if (child.pid !== undefined) writeFileSync(pidPath, JSON.stringify({ pid: child.pid, owner: process.pid, url, startedAt: Date.now() }, null, 2), { mode: 0o600 });
  log(`started smolvm serve ${version} (pid ${child.pid}) at ${url}`);

  const stop = async () => {
    if (exited !== undefined) return;
    child.kill("SIGTERM");
    await Promise.race([exitPromise, sleep(10_000)]);
    if (exited === undefined) child.kill("SIGKILL");
    await Promise.race([exitPromise, sleep(2_000)]);
    rmSync(pidPath, { force: true });
    logStream.end();
  };
  return { client: new LocalClient(url), url, owned: true, version, stop };
}
