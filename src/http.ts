// A small HTTP client on node:http that speaks to a Unix socket or a loopback
// port with the same call. fetch cannot dial a Unix socket without undici's
// Agent, which Node does not expose as a public API.
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";

export interface Endpoint {
  socketPath?: string;
  host?: string;
  port?: number;
}

export function parseEndpoint(url: string): Endpoint {
  if (url.startsWith("unix://")) return { socketPath: url.slice("unix://".length) };
  const u = new URL(url);
  if (u.protocol !== "http:") throw new Error(`unsupported URL scheme in ${url}: only http and unix are supported`);
  return { host: u.hostname, port: Number(u.port || 80) };
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface RequestOptions {
  method: string;
  path: string;
  json?: unknown;
  body?: Buffer | string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function httpCall(ep: Endpoint, opts: RequestOptions): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let payload: Buffer | undefined;
    if (opts.json !== undefined) {
      payload = Buffer.from(JSON.stringify(opts.json));
      headers["content-type"] = "application/json";
    } else if (opts.body !== undefined) {
      payload = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body);
      headers["content-type"] ??= "application/octet-stream";
    }
    if (payload) headers["content-length"] = String(payload.length);

    const req = httpRequest(
      {
        method: opts.method,
        path: opts.path,
        headers,
        ...(ep.socketPath ? { socketPath: ep.socketPath } : { host: ep.host, port: ep.port }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on("error", reject);
      },
    );
    if (opts.timeoutMs !== undefined) {
      req.setTimeout(opts.timeoutMs, () => {
        req.destroy(new Error(`request ${opts.method} ${opts.path} timed out after ${opts.timeoutMs} ms`));
      });
    }
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
