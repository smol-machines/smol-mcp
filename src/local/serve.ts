// Owns the `smolvm serve` process this server needs. Use an existing serve
// when one answers; otherwise start one in the runtime dir and stop it on
// exit. Only one serve can run per host (each binds 127.0.0.1:10081 for the
// guest rollout ingress), so a failed spawn names that cause.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants, createWriteStream, existsSync, rmSync } from "node:fs";
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

export async function ensureServe(cfg: Config, log: (msg: string) => void): Promise<ServeHandle> {
  ensureRuntimeDir(cfg.runtimeDir);

  for (const url of candidateUrls(cfg)) {
    const version = await probe(url);
    if (version !== undefined) {
      log(`using existing smolvm serve ${version} at ${url}`);
      return { client: new LocalClient(url), url, owned: false, version, stop: async () => {} };
    }
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
  const logStream = createWriteStream(logPath, { flags: "a" });
  let stderrTail = "";
  const child: ChildProcess = spawn(cfg.smolvm, ["serve", "start", "--listen", listen], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
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
  log(`started smolvm serve ${version} (pid ${child.pid}) at ${url}`);

  const stop = async () => {
    if (exited !== undefined) return;
    child.kill("SIGTERM");
    await Promise.race([exitPromise, sleep(10_000)]);
    if (exited === undefined) child.kill("SIGKILL");
    await Promise.race([exitPromise, sleep(2_000)]);
    logStream.end();
  };
  return { client: new LocalClient(url), url, owned: true, version, stop };
}
