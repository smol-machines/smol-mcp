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
import type { CallCtx, CreateOptions, ExecOptions, ExecResult, LogOptions, LogPage, MachineBackend, MachineView, NetworkPolicy, StartOptions } from "../backend.js";

export const CloudNetworkSchema = z.looseObject({ mode: z.string(), cidrs: z.array(z.string()).nullish() });

export const CloudMachineSchema = z.looseObject({
  id: z.string(),
  name: z.string().nullish(),
  state: z.string(),
  source: z.looseObject({ type: z.string(), reference: z.string() }).nullish(),
  resources: z.looseObject({ cpus: z.number().nullish(), memoryMb: z.number().nullish() }).nullish(),
  network: CloudNetworkSchema.nullish(),
  createdAt: z.string(),
  url: z.string().nullish(),
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

// The machine event log: what the control plane did to the machine, not what
// the guest wrote to its console. It is the only log this API publishes.
export const CloudEventSchema = z.looseObject({ id: z.string(), level: z.string(), message: z.string(), createdAt: z.string() });

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
    url: m.url ?? null,
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
    // The two are not combined on this target. A caller who wants both is
    // asking for something this server will not create.
    if (opts.ports && opts.ports.length > 0 && opts.network.mode === "blocked") {
      throw new BackendError(
        `refusing to create ${opts.name} on cloud with a published port and blocked egress: create it with network open, or with an allow-list naming the hosts it needs, or create it with no published port`,
        "BLOCKED_EGRESS_WITH_PORT",
      );
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
      ...(opts.branchable === true ? { branchable: true } : {}),
      ...(opts.ports && opts.ports.length > 0 ? { ports: opts.ports.map((p) => ({ port: p.guest })) } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
      ...(opts.autoStopSeconds !== undefined ? { autoStopSeconds: opts.autoStopSeconds } : {}),
    };
    return cloudView(await this.call("POST", "/v1/machines", CloudMachineSchema, { json: body, timeoutMs: 180_000, signal: ctx.signal }));
  }

  // No branchable here: this API takes it on the create and refuses to turn
  // it on for a machine that exists, which its own 409 says in as many words.
  async startMachine(nameOrId: string, opts: StartOptions = {}): Promise<MachineView> {
    const ctx = opts.ctx ?? {};
    const id = await this.resolve(nameOrId, ctx);
    const res = await this.raw("POST", `/v1/machines/${encodeURIComponent(id)}/start`, { json: {}, timeoutMs: 180_000, signal: ctx.signal });
    if (res.status < 200 || res.status >= 300) throw cloudError("POST", `/v1/machines/${id}/start`, res.status, res.text, res.requestId);
    // 202 with no body is the detached form; read the machine back so the
    // caller always gets a view rather than an empty object.
    if (res.text.trim() === "") return this.getMachine(id, ctx);
    const parsed = CloudMachineSchema.safeParse(JSON.parse(res.text));
    return parsed.success ? cloudView(parsed.data) : this.getMachine(id, ctx);
  }

  // 201 with the child's record. A source that was not created branchable
  // answers 409, and that message names the fix, so it is passed through.
  async branchMachine(nameOrId: string, childName: string, ctx: CallCtx = {}): Promise<MachineView> {
    const id = await this.resolve(nameOrId, ctx);
    const path = `/v1/machines/${encodeURIComponent(id)}/fork`;
    const res = await this.raw("POST", path, { json: { name: childName }, timeoutMs: 300_000, signal: ctx.signal });
    if (res.status < 200 || res.status >= 300) throw cloudError("POST", path, res.status, res.text, res.requestId);
    const parsed = CloudMachineSchema.safeParse(JSON.parse(res.text));
    if (!parsed.success) throw new BackendError(`POST ${path}: unexpected response shape: ${parsed.error.message}`, "BAD_RESPONSE");
    return cloudView(parsed.data);
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
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      ...(r.stdoutTruncated === true ? { stdoutTruncated: true } : {}),
      ...(r.stderrTruncated === true ? { stderrTruncated: true } : {}),
    };
  }

  // The documented shape is the path as a suffix with no leading slash:
  // `PUT /v1/machines/{id}/files/workspace/app.py`, and the same for GET. The
  // published schema lists the route with only `{id}`, so a deployment that
  // predates the suffix answers 404 or 405 and the exec fallback below runs
  // instead. One 2xx from the route settles it for the life of this client:
  // after that a 404 is a missing file and not a missing route.
  private filesRoute: "unknown" | "present" | "absent" = "unknown";

  private filesPath(id: string, path: string): string {
    const suffix = path
      .split("/")
      .filter((seg) => seg !== "")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return `/v1/machines/${encodeURIComponent(id)}/files/${suffix}`;
  }

  // A status that says the route is not there, as opposed to one that says
  // something about the file.
  private routeMissing(status: number): boolean {
    return this.filesRoute !== "present" && (status === 404 || status === 405 || status === 501);
  }

  async readFile(nameOrId: string, path: string, ctx: CallCtx = {}): Promise<Buffer> {
    const id = await this.resolve(nameOrId, ctx);
    const route = this.filesPath(id, path);
    const res = await this.raw("GET", route, { timeoutMs: 120_000, signal: ctx.signal });
    if (res.status >= 200 && res.status < 300) {
      this.filesRoute = "present";
      return res.buf;
    }
    if (!this.routeMissing(res.status)) throw cloudError("GET", route, res.status, res.text);
    // A 404 here is either no route or no file, and the fallback is what
    // tells them apart: if it reads the file, the route was missing; if it
    // does not, its own error is the one about the file.
    const buf = await this.readFileByExec(id, path, ctx);
    this.filesRoute = "absent";
    return buf;
  }

  async writeFile(nameOrId: string, path: string, content: Buffer, ctx: CallCtx = {}): Promise<{ path: string; size: number }> {
    const id = await this.resolve(nameOrId, ctx);
    const route = this.filesPath(id, path);
    const res = await this.raw("PUT", route, { body: content, timeoutMs: 120_000, signal: ctx.signal });
    if (res.status >= 200 && res.status < 300) {
      this.filesRoute = "present";
      return { path, size: content.length };
    }
    if (!this.routeMissing(res.status)) throw cloudError("PUT", route, res.status, res.text);
    const written = await this.writeFileByExec(id, path, content, ctx);
    this.filesRoute = "absent";
    return written;
  }

  // The fallback. base64 through exec keeps the bytes binary-safe and uses
  // the same auto-starting path every other cloud call does, at the cost of
  // the exec response cap.
  private async readFileByExec(nameOrId: string, path: string, ctx: CallCtx = {}): Promise<Buffer> {
    const r = await this.exec(nameOrId, { command: ["sh", "-c", `base64 < ${shellQuote(path)}`], timeoutSecs: 120 }, undefined, ctx);
    if (r.exitCode !== 0) throw new BackendError(`read ${path}: exit ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}`, "READ_FAILED");
    // The exec text stream is capped server side. Decoding a cut base64
    // stream returns a shorter file with no error, which is the one failure
    // a caller cannot detect from the bytes it got.
    if (r.stdoutTruncated === true) {
      throw new BackendError(`read ${path}: the file is larger than one exec response carries, and the fallback read path cannot page it`, "TRUNCATED");
    }
    return Buffer.from(r.stdout.replace(/\s+/g, ""), "base64");
  }

  private async writeFileByExec(nameOrId: string, path: string, content: Buffer, ctx: CallCtx = {}): Promise<{ path: string; size: number }> {
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

  // The cursor here is the id of the last event handed out. The route takes
  // neither a tail nor a since, so the whole log arrives and both are applied
  // here; an id that is no longer in the log means the log rolled past it, so
  // the page starts again from the tail rather than silently returning
  // everything.
  async logs(nameOrId: string, opts: LogOptions): Promise<LogPage> {
    const ctx = opts.ctx ?? {};
    const id = await this.resolve(nameOrId, ctx);
    const answered = await this.call("GET", `/v1/machines/${encodeURIComponent(id)}/events`, z.array(CloudEventSchema), { timeoutMs: 30_000 });
    // The route answers newest first. Everything below reads a log the way a
    // console log reads, oldest first, and a cursor taken from the wrong end
    // is a cursor that never advances: the id of what this call thought was
    // the newest event was actually the oldest, so the next page was always
    // empty and a follower saw nothing arrive. Sort rather than reverse,
    // because the order is the route's choice and not a promise.
    const events = [...answered].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const after = opts.cursor === undefined ? -1 : events.findIndex((e) => e.id === cursorId(opts.cursor));
    const fresh = after >= 0 ? events.slice(after + 1) : events.slice(-opts.tail);
    const last = events.at(-1);
    return { lines: fresh.map(formatEvent), cursor: last === undefined ? (opts.cursor ?? "") : `e:${last.id}`, truncated: false };
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

// A cursor this client issued, or nothing when it came from the other target.
function cursorId(cursor: string | undefined): string | undefined {
  return cursor !== undefined && cursor.startsWith("e:") ? cursor.slice(2) : undefined;
}

// One event, in the shape a console log line has: when, how loud, what.
export function formatEvent(e: { createdAt: string; level: string; message: string }): string {
  return `${e.createdAt} ${e.level.toUpperCase()} ${e.message}`;
}

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
