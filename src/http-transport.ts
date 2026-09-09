// The second entry point: the same eleven tools over Streamable HTTP, so the
// agent can sit outside the machine the server runs in. stdio stays the
// default and this file is not on its path.
//
// Every request carries a bearer token and the server refuses to start
// without one, because the tools create and run VMs: an unauthenticated
// listener on a published port is a remote code execution service.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { MachineBackend } from "./backend.js";
import type { Config } from "./config.js";
import { allowedHosts, allowedOrigins } from "./config.js";
import { createServer } from "./server.js";
import type { SmolMcp } from "./server.js";

// A tool call carries file content, so the cap is well above a JSON-RPC
// envelope; it exists so a stray upload cannot exhaust the guest's memory.
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface HttpTransportOptions {
  cfg: Config;
  log?: (msg: string) => void;
  localBackend?: MachineBackend;
}

export interface HttpTransportHandle {
  server: Server;
  port: number;
  sessions: number;
  close(): Promise<void>;
}

// Constant-time over digests: comparing the raw strings would leak the token's
// length through the comparison, and timingSafeEqual throws on a length
// mismatch, which is the same leak as an early return.
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Two places to carry the token. A deployment can put something else in
// `authorization` before the request reaches this server, so a client that
// cannot spend that header sets `x-smol-mcp-token` instead.
export function presentedToken(headers: IncomingMessage["headers"]): string {
  const alt = headers["x-smol-mcp-token"];
  if (typeof alt === "string" && alt !== "") return alt;
  const auth = headers.authorization;
  if (typeof auth === "string" && /^bearer /i.test(auth)) return auth.slice(7).trim();
  return "";
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

// JSON-RPC shaped, because the caller is an MCP client and a bare string is
// not something it can report.
function rpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(chunks.length === 0 ? undefined : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// The bin's flags, here rather than in the bin so a test can call them without
// starting a listener.
export function applyArgs(cfg: Config, argv: string[]): Config {
  const out = { ...cfg };
  for (let i = 0; i < argv.length; i += 2) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    if (arg === "--host") out.httpHost = value;
    else if (arg === "--port") out.httpPort = Number(value);
    else if (arg === "--path") out.httpPath = value;
    else throw new Error(`unknown argument ${arg} (accepted: --host, --port, --path)`);
  }
  if (!Number.isInteger(out.httpPort) || out.httpPort <= 0) throw new Error(`--port must be a positive integer, got ${String(out.httpPort)}`);
  if (!out.httpPath.startsWith("/")) throw new Error(`--path must start with a slash, got ${out.httpPath}`);
  return out;
}

export async function startHttpTransport(opts: HttpTransportOptions): Promise<HttpTransportHandle> {
  const { cfg } = opts;
  const log = opts.log ?? ((msg: string) => process.stderr.write(`smol-mcp: ${msg}\n`));
  if (cfg.authToken === "") {
    throw new Error("the HTTP transport requires SMOL_MCP_AUTH_TOKEN: these tools create and run virtual machines, so an unauthenticated listener is a remote shell");
  }

  // One McpServer per session: the SDK binds a server to a single transport,
  // and a session's ephemeral machines are deleted when its transport closes,
  // which is the HTTP equivalent of stdin EOF.
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; app: SmolMcp; lastSeen: number; inFlight: number }>();

  const openSession = async (port: number): Promise<StreamableHTTPServerTransport> => {
    const app = await createServer({ cfg, log, ...(opts.localBackend ? { localBackend: opts.localBackend } : {}) });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // A page in a browser can be made to resolve a name to this address and
      // then talk to it; the token is what stops it, and the Host and Origin
      // checks are what stop it before that. Both lists come from config, and
      // an empty allow-list checks nothing, so the loopback default names the
      // addresses a loopback bind can be reached at.
      enableDnsRebindingProtection: true,
      allowedHosts: allowedHosts(cfg, port),
      allowedOrigins: allowedOrigins(cfg),
      // Plain JSON replies rather than an SSE frame per response: the cloud
      // connect bridge is an HTTP proxy of unknown buffering, and a tool call
      // that needs no streaming should not depend on one.
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, app, lastSeen: Date.now(), inFlight: 0 });
        log(`http session ${id} opened (${sessions.size} open)`);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined) sessions.delete(id);
      void app.shutdown().then((r) => {
        if (r.deleted.length > 0) log(`session ${id ?? "?"} closed: deleted ${r.deleted.join(", ")}`);
      });
    };
    // The SDK's class declares onclose as `(() => void) | undefined` while the
    // Transport interface declares it optional, which this build's
    // exactOptionalPropertyTypes reads as two different types.
    await app.server.connect(transport as never);
    return transport;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Authenticate first, then route. The other order answered an
    // unauthenticated request with the endpoint path and the JSON-RPC shape,
    // which is the whole map of this listener given away for free.
    if (!tokenMatches(presentedToken(req.headers), cfg.authToken)) {
      rpcError(res, 401, -32001, "unauthorized: send the bearer token in authorization or x-smol-mcp-token", { "www-authenticate": "Bearer" });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== cfg.httpPath) {
      rpcError(res, 404, -32004, `no MCP endpoint at ${url.pathname}; it is at ${cfg.httpPath}`);
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const known = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (known) {
      // A tool call can hold a request open for minutes: creating a machine
      // waits for it to boot. Idle means no request at all, so a session is
      // marked busy for as long as one is in flight and again when it ends.
      known.lastSeen = Date.now();
      known.inFlight += 1;
      const done = () => {
        known.lastSeen = Date.now();
        known.inFlight = Math.max(0, known.inFlight - 1);
      };
      res.on("close", done);
      res.on("finish", done);
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!known) {
        rpcError(res, 404, -32001, "unknown or missing mcp-session-id");
        return;
      }
      await known.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== "POST") {
      rpcError(res, 405, -32000, `method ${req.method ?? "?"} not allowed`, { allow: "GET, POST, DELETE" });
      return;
    }

    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw === undefined ? undefined : JSON.parse(raw.toString("utf8"));
    } catch (err) {
      rpcError(res, 400, -32700, `could not read request body: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (known) {
      await known.transport.handleRequest(req, res, body);
      return;
    }
    if (sessionId === undefined && isInitializeRequest(body)) {
      const transport = await openSession(port);
      await transport.handleRequest(req, res, body);
      return;
    }
    rpcError(res, 400, -32000, "no valid mcp-session-id, and this is not an initialize request");
  };

  // The port is not known until the listener is bound (a test asks for 0),
  // and the Host allow-list is built from it.
  let port = cfg.httpPort;

  const server = createHttpServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log(`http request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) rpcError(res, 500, -32603, "internal error");
      else res.end();
    });
  });

  // A client that goes away without sending DELETE leaves its session, its
  // server instance and its ephemeral machines behind for the life of the
  // process. Closing the transport runs the same cleanup the DELETE does.
  const sweepMs = Math.max(1000, Math.floor((cfg.httpSessionIdleSecs * 1000) / 4));
  const sweep = setInterval(() => {
    const deadline = Date.now() - cfg.httpSessionIdleSecs * 1000;
    for (const [id, s] of [...sessions.entries()]) {
      if (s.inFlight > 0 || s.lastSeen > deadline) continue;
      log(`http session ${id} idle for ${cfg.httpSessionIdleSecs} s, closing it`);
      sessions.delete(id);
      void s.transport.close();
    }
  }, sweepMs);
  sweep.unref?.();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.httpPort, cfg.httpHost, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : cfg.httpPort;
  log(`listening for MCP over HTTP on http://${cfg.httpHost}:${port}${cfg.httpPath}`);
  if (allowedHosts(cfg, port).length === 0) {
    log(`no Host allow-list for a listener bound to ${cfg.httpHost}: set SMOL_MCP_HTTP_ALLOWED_HOSTS to the name clients dial, or the bearer token is the only gate`);
  }

  return {
    server,
    port,
    get sessions() {
      return sessions.size;
    },
    close: async () => {
      clearInterval(sweep);
      // Sessions first: closing the listener does not run their cleanup, and
      // an ephemeral machine outlives this process if nothing deletes it.
      for (const { transport } of [...sessions.values()]) await transport.close();
      // A kept-alive connection with no request in flight is not closed by
      // server.close(), which then waits for a client that may never come
      // back; on the exit path that is a shutdown that never finishes.
      server.closeIdleConnections();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
