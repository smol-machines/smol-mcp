// Typed client over the local API. Every method asserts the body shape with
// zod and turns an {error, code} body into a BackendError carrying the code.
import type { ZodType } from "zod";
import {
  ApiErrorResponseSchema,
  DeleteResponseSchema,
  ExecResponseSchema,
  FileUploadResponseSchema,
  HealthResponseSchema,
  ListMachinesResponseSchema,
  MachineInfoSchema,
  PullImageResponseSchema,
} from "../api.js";
import type { CreateMachineRequest, ExecRequest, ImageInfo, MachineInfo } from "../api.js";
import { BackendError } from "../backend.js";
import type { CallCtx, CreateOptions, ExecOptions, ExecResult, MachineBackend, MachineView, NetworkPolicy } from "../backend.js";
import { httpCall, parseEndpoint } from "../http.js";
import type { Endpoint, HttpResponse } from "../http.js";

const API = "/api/v1";

// Locally a machine is addressed by its name, so id and name are the same
// string; the cloud target is the one that has to resolve between them.
export function localView(m: MachineInfo): MachineView {
  const hosts = m.allowedHosts ?? [];
  const cidrs = m.allowedCidrs ?? [];
  const restricted = hosts.length > 0 || cidrs.length > 0;
  return {
    id: m.name,
    name: m.name,
    state: m.state,
    cpus: m.cpus,
    memoryMb: m.memoryMb,
    network: restricted ? `allow(${[...hosts, ...cidrs].join(",")})` : m.network ? "open" : "blocked",
    createdAt: m.createdAt,
    image: null,
    pid: m.pid ?? null,
  };
}

// `network` is the schema's field name, not `net`. An egress allow-list is
// carried in allowedHosts/allowedCidrs; the API rejects a create whose image
// still has to be pulled and which has no egress path at all, so `blocked`
// here is passed through and the API's own error explains it.
export function toLocalNetwork(p: NetworkPolicy): { network: boolean; allowedHosts?: string[]; allowedCidrs?: string[] } {
  if (p.mode === "open") return { network: true };
  if (p.mode === "blocked") return { network: false };
  return {
    network: false,
    ...(p.hosts && p.hosts.length > 0 ? { allowedHosts: p.hosts } : {}),
    ...(p.cidrs && p.cidrs.length > 0 ? { allowedCidrs: p.cidrs } : {}),
  };
}

function apiError(res: HttpResponse, what: string): BackendError {
  const text = res.body.toString("utf8");
  try {
    const parsed = ApiErrorResponseSchema.parse(JSON.parse(text));
    return new BackendError(`${what}: ${parsed.error}`, parsed.code);
  } catch {
    return new BackendError(`${what}: HTTP ${res.status} ${text.slice(0, 500)}`, `HTTP_${res.status}`);
  }
}

function parseBody<T>(res: HttpResponse, schema: ZodType<T>, what: string): T {
  const text = res.body.toString("utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BackendError(`${what}: response is not JSON: ${text.slice(0, 200)}`, "BAD_RESPONSE");
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new BackendError(`${what}: unexpected response shape: ${result.error.message}`, "BAD_RESPONSE");
  }
  return result.data;
}

export function parseSseData(text: string): string[] {
  // The logs route is SSE: one `data: <line>` per event, blank line between.
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) out.push(line.slice(5).replace(/^ /, ""));
  }
  return out;
}

export class LocalClient implements MachineBackend {
  readonly target = "local" as const;
  private readonly ep: Endpoint;

  constructor(readonly url: string) {
    this.ep = parseEndpoint(url);
  }

  private async call(method: string, path: string, opts: { json?: unknown; body?: Buffer; timeoutMs?: number; signal?: AbortSignal | undefined } = {}) {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return httpCall(this.ep, {
      method,
      path,
      ...(opts.json !== undefined ? { json: opts.json } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      timeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  async health(timeoutMs = 2000): Promise<{ status: string; version: string }> {
    const res = await this.call("GET", "/health", { timeoutMs });
    if (res.status !== 200) throw apiError(res, "health");
    return parseBody(res, HealthResponseSchema, "health");
  }

  async listMachines(ctx: CallCtx = {}): Promise<MachineView[]> {
    const res = await this.call("GET", `${API}/machines`, { signal: ctx.signal });
    if (res.status !== 200) throw apiError(res, "list machines");
    return parseBody(res, ListMachinesResponseSchema, "list machines").machines.map(localView);
  }

  async getMachine(name: string, ctx: CallCtx = {}): Promise<MachineView> {
    const res = await this.call("GET", `${API}/machines/${encodeURIComponent(name)}`, { signal: ctx.signal });
    if (res.status !== 200) throw apiError(res, `get machine ${name}`);
    return localView(parseBody(res, MachineInfoSchema, `get machine ${name}`));
  }

  async createMachine(opts: CreateOptions, ctx: CallCtx = {}): Promise<MachineView> {
    const body: CreateMachineRequest = {
      name: opts.name,
      image: opts.image,
      cpus: opts.cpus,
      memoryMb: opts.memoryMb,
      ...toLocalNetwork(opts.network),
      ...(opts.cmd ? { cmd: opts.cmd } : {}),
      ...(opts.env ? { env: Object.entries(opts.env).map(([name, value]) => ({ name, value })) } : {}),
      ...(opts.ports && opts.ports.length > 0 ? { ports: opts.ports.map((p) => ({ host: p.host ?? p.guest, guest: p.guest })) } : {}),
      ...(opts.mounts && opts.mounts.length > 0 ? { mounts: opts.mounts } : {}),
      ...(opts.storageGb !== undefined ? { storageGb: opts.storageGb } : {}),
      ...(opts.overlayGb !== undefined ? { overlayGb: opts.overlayGb } : {}),
    };
    const res = await this.call("POST", `${API}/machines`, { json: body, signal: ctx.signal });
    if (res.status !== 200) throw apiError(res, `create machine ${opts.name}`);
    return localView(parseBody(res, MachineInfoSchema, `create machine ${opts.name}`));
  }

  async startMachine(name: string, ctx: CallCtx = {}): Promise<MachineView> {
    // A start pulls the image inside the guest; give it the ready budget.
    const res = await this.call("POST", `${API}/machines/${encodeURIComponent(name)}/start`, { json: {}, timeoutMs: 300_000, signal: ctx.signal });
    if (res.status !== 200) throw apiError(res, `start machine ${name}`);
    return localView(parseBody(res, MachineInfoSchema, `start machine ${name}`));
  }

  async stopMachine(name: string, ctx: CallCtx = {}): Promise<MachineView> {
    const res = await this.call("POST", `${API}/machines/${encodeURIComponent(name)}/stop`, { json: {}, timeoutMs: 120_000, signal: ctx.signal });
    if (res.status !== 200) throw apiError(res, `stop machine ${name}`);
    return localView(parseBody(res, MachineInfoSchema, `stop machine ${name}`));
  }

  // The local API bills nothing, so there is no usage figure to return here.
  async deleteMachine(name: string, ctx: CallCtx = {}): Promise<{ deleted: string }> {
    const res = await this.call("DELETE", `${API}/machines/${encodeURIComponent(name)}`, { timeoutMs: 120_000, signal: ctx.signal });
    if (res.status !== 200) throw apiError(res, `delete machine ${name}`);
    return { deleted: parseBody(res, DeleteResponseSchema, `delete machine ${name}`).deleted };
  }

  // A failed guest command is HTTP 200 with a non-zero exitCode in the body;
  // only a non-200 is a transport or API failure.
  async exec(name: string, req: ExecOptions, clientTimeoutMs?: number, ctx: CallCtx = {}): Promise<ExecResult> {
    const body: ExecRequest = {
      command: req.command,
      ...(req.timeoutSecs !== undefined ? { timeoutSecs: req.timeoutSecs } : {}),
      ...(req.workdir !== undefined ? { workdir: req.workdir } : {}),
      ...(req.env ? { env: Object.entries(req.env).map(([name, value]) => ({ name, value })) } : {}),
      ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
    };
    const res = await this.call("POST", `${API}/machines/${encodeURIComponent(name)}/exec`, {
      json: body,
      timeoutMs: clientTimeoutMs ?? ((req.timeoutSecs ?? 120) + 30) * 1000,
      signal: ctx.signal,
    });
    if (res.status !== 200) throw apiError(res, `exec in ${name}`);
    const parsed = parseBody(res, ExecResponseSchema, `exec in ${name}`);
    return { exitCode: parsed.exitCode, stdout: parsed.stdout, stderr: parsed.stderr };
  }

  async readFile(name: string, path: string, ctx: CallCtx = {}): Promise<Buffer> {
    const res = await this.call("GET", `${API}/machines/${encodeURIComponent(name)}/files/${encodeURIComponent(path)}`, { signal: ctx.signal });
    if (res.status !== 200) throw apiError(res, `read ${path} in ${name}`);
    return res.body;
  }

  async writeFile(name: string, path: string, content: Buffer, ctx: CallCtx = {}): Promise<{ path: string; size: number }> {
    const res = await this.call("PUT", `${API}/machines/${encodeURIComponent(name)}/files/${encodeURIComponent(path)}`, { body: content, signal: ctx.signal });
    if (res.status !== 200) throw apiError(res, `write ${path} in ${name}`);
    return parseBody(res, FileUploadResponseSchema, `write ${path} in ${name}`);
  }

  async logs(name: string, tail: number, ctx: CallCtx = {}): Promise<string[]> {
    // Without follow the stream ends after the tail; the timeout is the backstop.
    const res = await this.call("GET", `${API}/machines/${encodeURIComponent(name)}/logs?tail=${tail}&follow=false`, { timeoutMs: 15_000, signal: ctx.signal });
    if (res.status !== 200) throw apiError(res, `logs of ${name}`);
    return parseSseData(res.body.toString("utf8"));
  }

  async pullImage(name: string, image: string, ctx: CallCtx = {}): Promise<ImageInfo> {
    const res = await this.call("POST", `${API}/machines/${encodeURIComponent(name)}/images/pull`, { json: { image }, timeoutMs: 600_000, signal: ctx.signal });
    if (res.status !== 200) throw apiError(res, `pull ${image} into ${name}`);
    return parseBody(res, PullImageResponseSchema, `pull ${image} into ${name}`).image;
  }
}
