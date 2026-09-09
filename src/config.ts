// Tethered defaults. Every number here is stated in the README with the reason
// it is what it is; change it there too.
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const ConfigSchema = z.object({
  // Path to the smolvm binary. "smolvm" resolves on PATH.
  smolvm: z.string().default("smolvm"),
  // Address of a serve to use. Empty means: probe the known locations, then
  // start one in runtimeDir. Forms: unix:///abs/path.sock or http://127.0.0.1:port
  localUrl: z.string().default(""),
  // Where this server keeps its socket, log, and machine state file.
  runtimeDir: z.string().default(""),
  // Name prefix that marks a machine as ephemeral, deleted on stdio EOF.
  machinePrefix: z.string().default("mcp-"),
  memoryMb: z.number().int().positive().default(2048),
  cpus: z.number().int().positive().default(2),
  // The local run-once default only. It is "open" because the local API
  // refuses a create with no egress path whenever the image still has to be
  // pulled from a registry, and run-once always pulls; the cloud target,
  // where the control plane pulls, defaults to blocked. See the README.
  runOnceNetwork: z.enum(["open", "blocked"]).default("open"),
  // Control-plane backstop on an ephemeral machine, sent as ttlSeconds where
  // the API has one (cloud). Long enough not to cut a legitimate run short,
  // short enough that a killed server cannot leave a machine billing forever.
  ephemeralTtlSecs: z.number().int().positive().default(3600),
  // Idle stop for an ephemeral machine, sent as autoStopSeconds where the API
  // has one (cloud), together with ephemeral so the stop is a delete. Long
  // enough that an agent thinking between two calls does not lose its
  // machine, short enough that an abandoned one is not billed for the hour
  // ephemeralTtlSecs allows.
  ephemeralAutoStopSecs: z.number().int().positive().default(900),
  execTimeoutSecs: z.number().int().positive().default(120),
  // Ceiling on the timeoutSecs a caller may ask for. A tool call holds a
  // machine open, and on the cloud target a bill, for as long as it runs, so
  // the longest one is a decision this server makes rather than the caller.
  maxExecTimeoutSecs: z.number().int().positive().default(900),
  maxOutputBytes: z.number().int().positive().default(64 * 1024),
  readyTimeoutSecs: z.number().int().positive().default(120),
  serveStartTimeoutSecs: z.number().int().positive().default(60),
  logsTail: z.number().int().positive().default(100),
  // How often a subscribed log resource is polled for new lines. Neither log
  // route pushes, so following is a poll; this is the interval between one
  // poll and the next, per subscribed machine.
  logsPollSecs: z.number().int().positive().default(2),
  cloudUrl: z.string().default("https://api.smolmachines.com"),
  cloudToken: z.string().default(""),
  // Which targets this process serves, decided once at startup. "auto" is
  // both when a cloud token is configured and local otherwise. In a
  // single-target mode the `target` argument is not in any tool schema, so a
  // client cannot name a fleet this process was not started to reach.
  targets: z.enum(["auto", "local", "cloud", "both"]).default("auto"),
  // The HTTP transport only (dist/http-cli.js); stdio reads none of these.
  // The bind is loopback by default because publishing the port is a decision
  // to be made once, in the open, and not the consequence of a default.
  httpHost: z.string().default("127.0.0.1"),
  httpPort: z.number().int().positive().default(8080),
  httpPath: z.string().default("/mcp"),
  // Host header values this listener answers to, comma separated. Empty and
  // bound to loopback: the loopback names for the port. Empty and bound to
  // anything else: the name is not knowable here, so the Host check is off
  // and the bearer token is the only gate.
  // How long a session may go without a request before it is closed and its
  // ephemeral machines are deleted. A client that goes away without sending
  // DELETE otherwise leaves a server instance, and its machines, for the life
  // of the process.
  httpSessionIdleSecs: z.number().int().positive().default(1800),
  httpAllowedHosts: z.string().default(""),
  // Origin header values a browser page may carry, comma separated. Empty
  // means no browser origin is expected; a request that carries one is
  // refused only when this names some other value.
  httpAllowedOrigins: z.string().default(""),
  // Required by the HTTP transport, which refuses to start without it. There
  // is no default: a default would be a published credential.
  authToken: z.string().default(""),
});

export type Config = z.infer<typeof ConfigSchema>;

const ENV_KEYS: Record<keyof Config, string> = {
  smolvm: "SMOLVM",
  localUrl: "SMOL_LOCAL_URL",
  runtimeDir: "SMOL_MCP_RUNTIME_DIR",
  machinePrefix: "SMOL_MCP_MACHINE_PREFIX",
  memoryMb: "SMOL_MCP_MEMORY_MB",
  cpus: "SMOL_MCP_CPUS",
  runOnceNetwork: "SMOL_MCP_RUN_ONCE_NETWORK",
  ephemeralTtlSecs: "SMOL_MCP_EPHEMERAL_TTL_SECS",
  ephemeralAutoStopSecs: "SMOL_MCP_EPHEMERAL_AUTO_STOP_SECS",
  execTimeoutSecs: "SMOL_MCP_EXEC_TIMEOUT_SECS",
  maxExecTimeoutSecs: "SMOL_MCP_MAX_EXEC_TIMEOUT_SECS",
  maxOutputBytes: "SMOL_MCP_MAX_OUTPUT_BYTES",
  readyTimeoutSecs: "SMOL_MCP_READY_TIMEOUT_SECS",
  serveStartTimeoutSecs: "SMOL_MCP_SERVE_START_TIMEOUT_SECS",
  logsTail: "SMOL_MCP_LOGS_TAIL",
  logsPollSecs: "SMOL_MCP_LOGS_POLL_SECS",
  cloudUrl: "SMOL_CLOUD_URL",
  cloudToken: "SMOL_CLOUD_TOKEN",
  targets: "SMOL_MCP_TARGETS",
  httpHost: "SMOL_MCP_HTTP_HOST",
  httpPort: "SMOL_MCP_HTTP_PORT",
  httpPath: "SMOL_MCP_HTTP_PATH",
  httpSessionIdleSecs: "SMOL_MCP_HTTP_SESSION_IDLE_SECS",
  httpAllowedHosts: "SMOL_MCP_HTTP_ALLOWED_HOSTS",
  httpAllowedOrigins: "SMOL_MCP_HTTP_ALLOWED_ORIGINS",
  authToken: "SMOL_MCP_AUTH_TOKEN",
};

function coerce(key: keyof Config, raw: string): unknown {
  const shape = ConfigSchema.shape[key];
  const inner = shape.def.innerType;
  if (inner instanceof z.ZodNumber) return Number(raw);
  if (inner instanceof z.ZodBoolean) return !["0", "false", "no", "off", ""].includes(raw.toLowerCase());
  return raw;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== "" ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  return join(base, "smol-mcp", "config.json");
}

export function defaultRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  // A Unix socket path is limited to 104 bytes on macOS, so the directory must
  // be short. os.tmpdir() is per-user and mode 0700 on macOS; XDG_RUNTIME_DIR
  // is the same thing on Linux.
  const xdg = env.XDG_RUNTIME_DIR;
  const base = xdg && xdg !== "" ? xdg : tmpdir();
  return join(base, "smol-mcp");
}

// Precedence: env > config file > defaults. A config file is JSON with the
// same keys as ConfigSchema; unknown keys are an error so a typo cannot pass
// as a default (the local API's own silent-ignore behaviour is the lesson).
export function loadConfig(env: NodeJS.ProcessEnv = process.env, fileOverride?: string): Config {
  let fromFile: Record<string, unknown> = {};
  const path = fileOverride ?? env.SMOL_MCP_CONFIG ?? defaultConfigPath(env);
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = undefined;
  }
  if (text !== undefined) {
    const parsed: unknown = JSON.parse(text);
    fromFile = ConfigSchema.strict().partial().parse(parsed);
  }
  const fromEnv: Record<string, unknown> = {};
  for (const key of Object.keys(ENV_KEYS) as (keyof Config)[]) {
    const raw = env[ENV_KEYS[key]];
    if (raw !== undefined && raw !== "") fromEnv[key] = coerce(key, raw);
  }
  const merged = ConfigSchema.parse({ ...fromFile, ...fromEnv });
  if (merged.runtimeDir === "") merged.runtimeDir = defaultRuntimeDir(env);
  return merged;
}

// The three modes a running server can be in. "auto" never reaches a tool
// schema: it is resolved here, at startup.
export type TargetMode = "local" | "cloud" | "both";

export function resolveTargets(cfg: Config): TargetMode {
  if (cfg.targets !== "auto") return cfg.targets;
  return cfg.cloudToken === "" ? "local" : "both";
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

// The Host values this listener answers to. A browser reaching a private
// address through a rebound name sends the name it dialled, so an allow-list
// of the names this server expects is what separates them.
export function allowedHosts(cfg: Config, port = cfg.httpPort): string[] {
  const named = splitList(cfg.httpAllowedHosts);
  if (named.length > 0) return named;
  if (!isLoopback(cfg.httpHost)) return [];
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

export function allowedOrigins(cfg: Config): string[] {
  return splitList(cfg.httpAllowedOrigins);
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
