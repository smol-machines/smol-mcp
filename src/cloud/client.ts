// Client over the smol cloud REST API. Shapes are from the generated schema
// at https://smolmachines.com/openapi.json (smol cloud API 0.1.0) and from the
// calls this client actually makes; the schema is behind the service, so a
// route missing from it is not a route that does not exist.
//
// This API disagrees with the local one about almost everything: a machine is
// addressed by id and not by name, the image is a tagged `source` object and
// not a string, resources and network are nested, env is a map and not a list,
// exec fields are `cwd`/`timeoutSeconds` and not `workdir`/`timeoutSecs`, and
// list returns a bare array. All of that is normalised here so the tools do
// not have to know which target they are on.
import { z } from "zod";
import type { ImageInfo } from "../api.js";
import { BackendError } from "../backend.js";
import type { CallCtx, CreateOptions, ExecOptions, ExecResult, MachineBackend, MachineView, NetworkPolicy } from "../backend.js";

export const CloudNetworkSchema = z.looseObject({ mode: z.string(), cidrs: z.array(z.string()).nullish() });

export const CloudMachineSchema = z.looseObject({
  id: z.string(),
  name: z.string().nullish(),
  state: z.string(),
  source: z.looseObject({ type: z.string(), reference: z.string() }).nullish(),
  resources: z.looseObject({ cpus: z.number().nullish(), memoryMb: z.number().nullish() }).nullish(),
  network: CloudNetworkSchema.nullish(),
  createdAt: z.string(),
});
export type CloudMachine = z.infer<typeof CloudMachineSchema>;

export const CloudExecSchema = z.looseObject({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  durationMs: z.number().nullish(),
  stdoutTruncated: z.boolean().nullish(),
  stderrTruncated: z.boolean().nullish(),
});

export const CloudUsageSchema = z.looseObject({ totalMicros: z.number().nullish() });
export const CloudDeleteSchema = z.looseObject({ usage: z.looseObject({}).nullish(), cost: CloudUsageSchema.nullish() });

export const AccountSchema = z.looseObject({
  status: z.string(),
  periodUsage: z.looseObject({ totalUptimeSeconds: z.number(), machineCount: z.number() }),
  periodCost: z.looseObject({ totalMicros: z.number(), amountDueMicros: z.number().nullish() }),
});
export type Account = z.infer<typeof AccountSchema>;

interface RawOptions {
  json?: unknown;
  body?: Buffer;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

interface RawResponse {
  status: number;
  text: string;
  buf: Buffer;
  requestId: string;
  retryAfter: string | undefined;
}

export class CloudNotConfigured extends BackendError {
  constructor() {
    super("cloud target is not configured: set SMOL_CLOUD_TOKEN (and SMOL_CLOUD_URL if it is not the default)", "CLOUD_NOT_CONFIGURED");
  }
}

// RFC 5737 TEST-NET-1, reserved for documentation and routed nowhere. It is
// the payload of a deny: an empty `cidrs` is refused outright with
// `allowCidrs network mode requires at least one CIDR or host`, so the deny is
// spelled as an allow-list of something unreachable.
export const DENY_CIDR = "192.0.2.0/24";

// The API answers `open`, `blocked` or `allowCidrs`. An allow-list of names
// goes in the same `cidrs` field: the error message above says the mode takes
// "at least one CIDR or host".
export function toCloudNetwork(p: NetworkPolicy): { mode: string; cidrs?: string[] } {
  if (p.mode === "open") return { mode: "open" };
  if (p.mode === "blocked") return { mode: "allowCidrs", cidrs: [DENY_CIDR] };
  const list = [...(p.cidrs ?? []), ...(p.hosts ?? [])];
  return { mode: "allowCidrs", cidrs: list.length > 0 ? list : [DENY_CIDR] };
}

export function cloudView(m: CloudMachine): MachineView {
  const created = Date.parse(m.createdAt);
  return {
    id: m.id,
    name: m.name ?? m.id,
    state: m.state,
    cpus: m.resources?.cpus ?? 0,
    memoryMb: m.resources?.memoryMb ?? 0,
    network: m.network?.mode ?? "unknown",
    createdAt: Number.isNaN(created) ? 0 : Math.floor(created / 1000),
    image: m.source?.reference ?? null,
    pid: null,
  };
}

// Error bodies are JSON on 401 and plain text on everything else, so a client
// that always calls .json() throws on the common failures. Read the text and
// only then try to find a message in it.
// The docs ask for the x-request-id of a failed request when reporting one,
// and it was never read, so the error an agent relayed had nothing the
// service could look up.
function cloudError(method: string, path: string, status: number, text: string, requestId?: string): BackendError {
  let message = text.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      const rec = parsed as Record<string, unknown>;
      const found = rec.message ?? rec.error ?? rec.detail;
      if (typeof found === "string") message = found;
    }
  } catch {
    // Plain text is the normal case here, not an anomaly.
  }
  const code = status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : `HTTP_${status}`;
  const id = requestId === undefined || requestId === "" ? "" : ` (x-request-id ${requestId})`;
  return new BackendError(`${method} ${path}: HTTP ${status} ${message.slice(0, 500)}${id}`, code);
}

// Statuses worth trying again: the service asked us to wait (429), or it was
// briefly unable to answer. Everything else is the request's own fault and
// will fail the same way however many times it is sent.
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The wait before attempt n, honouring Retry-After when the service names one.
export function retryDelayMs(attempt: number, retryAfter: string | undefined): number {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return Math.min(250 * 2 ** (attempt - 1), 4000);
}

export class CloudClient implements MachineBackend {
  readonly target = "cloud" as const;

  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly defaultTimeoutMs = 120_000,
    // Attempts after the first, for a status the service says is temporary.
    private readonly retries = 2,
  ) {}

  get configured(): boolean {
    return this.token !== "";
  }

  private async raw(method: string, path: string, opts: RawOptions = {}): Promise<RawResponse> {
    if (!this.configured) throw new CloudNotConfigured();
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    let body: string | Uint8Array | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.body !== undefined) {
      headers["content-type"] = "application/octet-stream";
      body = new Uint8Array(opts.body);
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      // The client's cancel and this call's own deadline, whichever comes
      // first. Without the first, a cancelled request runs to the second.
      signal: opts.signal === undefined ? AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs) : AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs)]),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, text: buf.toString("utf8"), buf, requestId: res.headers.get("x-request-id") ?? "", retryAfter: res.headers.get("retry-after") ?? undefined };
  }

  // One attempt, then up to `retries` more for a status the service says is
  // temporary. Retrying is off unless a call site asks for it: a create that
  // answered 500 may well have created the machine, and an exec may well have
  // run the command, so only reads opt in.
  private async withRetries(method: string, path: string, opts: RawOptions & { retries?: number } = {}): Promise<RawResponse> {
    const retries = opts.retries ?? 0;
    for (let attempt = 1; ; attempt += 1) {
      const res = await this.raw(method, path, opts);
      if (!TRANSIENT.has(res.status) || attempt > retries) return res;
      const wait = retryDelayMs(attempt, res.retryAfter);
      await sleep(wait);
      opts.signal?.throwIfAborted();
    }
  }

  private async call<T>(method: string, path: string, schema: z.ZodType<T>, opts: RawOptions & { retries?: number } = {}): Promise<T> {
    const res = await this.withRetries(method, path, opts);
    if (res.status < 200 || res.status >= 300) throw cloudError(method, path, res.status, res.text, res.requestId);
    let json: unknown;
    try {
      json = res.text === "" ? {} : JSON.parse(res.text);
    } catch {
      throw new BackendError(`${method} ${path}: response is not JSON: ${res.text.slice(0, 200)}`, "BAD_RESPONSE");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new BackendError(`${method} ${path}: unexpected response shape: ${parsed.error.message}`, "BAD_RESPONSE");
    return parsed.data;
  }

  async account(ctx: CallCtx = {}): Promise<Account> {
    return this.call("GET", "/v1/account", AccountSchema, { timeoutMs: 30_000, signal: ctx.signal, retries: this.retries });
  }

  async listMachines(ctx: CallCtx = {}): Promise<MachineView[]> {
    const list = await this.call("GET", "/v1/machines", z.array(CloudMachineSchema), { timeoutMs: 30_000, signal: ctx.signal, retries: this.retries });
    return list.map(cloudView);
  }

  // Every other route takes the id. A caller who has only a name pays one
  // extra list call, which is what the CLI does too.
  async resolve(nameOrId: string, ctx: CallCtx = {}): Promise<string> {
    if (nameOrId.startsWith("mach-")) return nameOrId;
    const list = await this.call("GET", "/v1/machines", z.array(CloudMachineSchema), { timeoutMs: 30_000, signal: ctx.signal, retries: this.retries });
    const hit = list.find((m) => m.name === nameOrId);
    if (!hit) throw new BackendError(`machine '${nameOrId}' not found on the cloud target`, "NOT_FOUND");
    return hit.id;
  }

  async getMachine(nameOrId: string, ctx: CallCtx = {}): Promise<MachineView> {
    const id = await this.resolve(nameOrId, ctx);
    return cloudView(await this.call("GET", `/v1/machines/${encodeURIComponent(id)}`, CloudMachineSchema, { timeoutMs: 30_000, signal: ctx.signal, retries: this.retries }));
  }

  async createMachine(opts: CreateOptions, ctx: CallCtx = {}): Promise<MachineView> {
    // A host path has no meaning on a fleet that is somewhere else, and the
    // cloud mount takes a named volume rather than a path, so this is a
    // refusal and not a silently dropped field.
    if (opts.mounts && opts.mounts.length > 0) {
      throw new BackendError("mounts are local only: a cloud machine has no host filesystem to mount from", "UNSUPPORTED");
    }
    if (opts.overlayGb !== undefined) {
      throw new BackendError("overlayGb is local only: a cloud machine has one disk, sized with storageGb", "UNSUPPORTED");
    }

    // No cmd: the cloud create request has no workload field, and a machine
    // here does not need one kept alive because exec auto-starts it.
    //
    // `ports` publishes a guest port; the control plane allocates the host
    // side and answers with an ingress URL, so the host number a local
    // mapping carries has nowhere to go here.
    const body = {
      name: opts.name,
      source: { type: "image", reference: opts.image },
      resources: { cpus: opts.cpus, memoryMb: opts.memoryMb, ...(opts.storageGb !== undefined ? { diskGb: opts.storageGb } : {}) },
      network: toCloudNetwork(opts.network),
      ...(opts.ports && opts.ports.length > 0 ? { ports: opts.ports.map((p) => ({ port: p.guest })) } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
    };
    return cloudView(await this.call("POST", "/v1/machines", CloudMachineSchema, { json: body, timeoutMs: 180_000, signal: ctx.signal }));
  }

  async startMachine(nameOrId: string, ctx: CallCtx = {}): Promise<MachineView> {
    const id = await this.resolve(nameOrId, ctx);
    const res = await this.raw("POST", `/v1/machines/${encodeURIComponent(id)}/start`, { json: {}, timeoutMs: 180_000, signal: ctx.signal });
    if (res.status < 200 || res.status >= 300) throw cloudError("POST", `/v1/machines/${id}/start`, res.status, res.text, res.requestId);
    // 202 with no body is the detached form; read the machine back so the
    // caller always gets a view rather than an empty object.
    if (res.text.trim() === "") return this.getMachine(id, ctx);
    const parsed = CloudMachineSchema.safeParse(JSON.parse(res.text));
    return parsed.success ? cloudView(parsed.data) : this.getMachine(id, ctx);
  }

  async stopMachine(nameOrId: string, ctx: CallCtx = {}): Promise<MachineView> {
    const id = await this.resolve(nameOrId, ctx);
    const res = await this.raw("POST", `/v1/machines/${encodeURIComponent(id)}/stop`, { json: {}, timeoutMs: 180_000, signal: ctx.signal });
    if (res.status < 200 || res.status >= 300) throw cloudError("POST", `/v1/machines/${id}/stop`, res.status, res.text, res.requestId);
    return this.getMachine(id, ctx);
  }

  // includeUsage turns the 204 into a 200 carrying the settled bill. A
  // mid-life /usage read is a lower bound, so this is the only number worth
  // recording.
  async deleteMachine(nameOrId: string, ctx: CallCtx = {}): Promise<{ deleted: string; usageMicros?: number }> {
    const id = await this.resolve(nameOrId, ctx);
    const path = `/v1/machines/${encodeURIComponent(id)}?includeUsage=true`;
    const res = await this.raw("DELETE", path, { timeoutMs: 120_000, signal: ctx.signal });
    if (res.status < 200 || res.status >= 300) throw cloudError("DELETE", path, res.status, res.text, res.requestId);
    const micros = findMicros(res.text);
    return { deleted: nameOrId, ...(micros !== undefined ? { usageMicros: micros } : {}) };
  }

  // HTTP 200 is returned for a guest command that failed, timed out, or had no
  // interpreter. exitCode in the body is the only thing that distinguishes
  // them, so nothing here reads the status as a verdict on the command.
  async exec(nameOrId: string, req: ExecOptions, clientTimeoutMs?: number, ctx: CallCtx = {}): Promise<ExecResult> {
    const id = await this.resolve(nameOrId, ctx);
    const body = {
      command: req.command,
      ...(req.workdir !== undefined ? { cwd: req.workdir } : {}),
      ...(req.env ? { env: req.env } : {}),
      ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
      ...(req.timeoutSecs !== undefined ? { timeoutSeconds: req.timeoutSecs } : {}),
    };
    // output=text asks for the plain fields; without it both families come back.
    const r = await this.call("POST", `/v1/machines/${encodeURIComponent(id)}/exec?output=text`, CloudExecSchema, {
      json: body,
      timeoutMs: clientTimeoutMs ?? ((req.timeoutSecs ?? 120) + 30) * 1000,
      signal: ctx.signal,
    });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }

  // The files route takes no parameter that any published schema names, and a
  // `?path=` guess answers 404 with an empty body, so there is nothing to code
  // against. Transfer goes through exec instead: base64 keeps it binary-safe
  // and it is the same auto-starting path every other cloud call uses.
  async readFile(nameOrId: string, path: string, ctx: CallCtx = {}): Promise<Buffer> {
    const r = await this.exec(nameOrId, { command: ["sh", "-c", `base64 < ${shellQuote(path)}`], timeoutSecs: 120 }, undefined, ctx);
    if (r.exitCode !== 0) throw new BackendError(`read ${path}: exit ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}`, "READ_FAILED");
    return Buffer.from(r.stdout.replace(/\s+/g, ""), "base64");
  }

  async writeFile(nameOrId: string, path: string, content: Buffer, ctx: CallCtx = {}): Promise<{ path: string; size: number }> {
    const b64 = content.toString("base64");
    const r = await this.exec(
      nameOrId,
      {
        command: ["sh", "-c", `mkdir -p "$(dirname ${shellQuote(path)})" && base64 -d > ${shellQuote(path)}`],
        stdin: b64,
        timeoutSecs: 120,
      },
      undefined,
      ctx,
    );
    if (r.exitCode !== 0) throw new BackendError(`write ${path}: exit ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}`, "WRITE_FAILED");
    return { path, size: content.length };
  }

  async logs(): Promise<string[]> {
    throw new BackendError("machine-logs is local only: the cloud API exposes an event log, not a console log", "NOT_IMPLEMENTED");
  }

  async pullImage(): Promise<ImageInfo> {
    throw new BackendError("pull-image is local only: the cloud control plane pulls the image itself at create", "NOT_IMPLEMENTED");
  }
}

// The DELETE body nests the settled cost, and the nesting has moved between
// releases, so take the first totalMicros anywhere in it rather than a path.
export function findMicros(text: string): number | undefined {
  try {
    const seen: unknown[] = [JSON.parse(text)];
    while (seen.length > 0) {
      const node = seen.pop();
      if (node === null || typeof node !== "object") continue;
      const rec = node as Record<string, unknown>;
      if (typeof rec.totalMicros === "number") return rec.totalMicros;
      seen.push(...Object.values(rec));
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
