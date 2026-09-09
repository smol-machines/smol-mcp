// An in-memory MachineBackend for unit tests. Records every call so a test
// can assert ordering (upload after readiness, delete after timeout).
import type { ImageInfo } from "../../src/api.js";
import { BackendError } from "../../src/backend.js";
import type { CallCtx, CreateOptions, ExecOptions, ExecResult, LogOptions, LogPage, MachineBackend, MachineView, StartOptions } from "../../src/backend.js";
import { ConfigSchema } from "../../src/config.js";
import type { Config } from "../../src/config.js";

export class FakeBackend implements MachineBackend {
  constructor(readonly target: "local" | "cloud" = "local") {}
  calls: { op: string; name?: string; args?: unknown }[] = [];
  machines = new Map<string, MachineView>();
  files = new Map<string, Buffer>();
  // exec handler, replaceable per test
  execImpl: (name: string, req: ExecOptions) => Promise<ExecResult> = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  deleteImpl: (name: string) => Promise<void> = async () => {};
  // create handler, replaceable per test
  createImpl: ((opts: CreateOptions) => Promise<void>) | undefined;

  // A backend whose id is not the name, the way the cloud API's is.
  idFor: (name: string) => string = (name) => name;

  private info(name: string, state: string): MachineView {
    return { id: this.idFor(name), name, state, cpus: 2, memoryMb: 2048, network: "open", createdAt: 1700000000, image: "alpine", pid: state === "running" ? 4242 : null };
  }
  async listMachines() {
    this.calls.push({ op: "list" });
    return [...this.machines.values()];
  }
  async getMachine(name: string) {
    this.calls.push({ op: "get", name });
    const m = this.machines.get(name);
    if (!m) throw new BackendError(`machine '${name}' not found`, "NOT_FOUND");
    return m;
  }
  async createMachine(opts: CreateOptions) {
    this.calls.push({ op: "create", name: opts.name, args: opts });
    if (this.createImpl) await this.createImpl(opts);
    if (this.machines.has(opts.name)) throw new BackendError(`machine '${opts.name}' already exists`, "CONFLICT");
    const m = this.info(opts.name, "created");
    this.machines.set(opts.name, m);
    return m;
  }
  async startMachine(name: string, opts: StartOptions = {}) {
    this.calls.push({ op: "start", name, args: opts });
    const m = this.info(name, "running");
    this.machines.set(name, m);
    return m;
  }
  // A branch source has to have been made one; the fake refuses like both
  // real targets do.
  branchable = new Set<string>();
  async branchMachine(name: string, childName: string) {
    this.calls.push({ op: "branch", name, args: childName });
    if (!this.branchable.has(name)) throw new BackendError(`machine '${name}' is not branchable`, "CONFLICT");
    const m = this.info(childName, "running");
    this.machines.set(childName, m);
    return m;
  }

  async stopMachine(name: string) {
    this.calls.push({ op: "stop", name });
    const m = this.info(name, "stopped");
    this.machines.set(name, m);
    return m;
  }
  async deleteMachine(nameOrId: string) {
    this.calls.push({ op: "delete", name: nameOrId });
    await this.deleteImpl(nameOrId);
    const name = this.machines.has(nameOrId) ? nameOrId : [...this.machines.keys()].find((k) => this.idFor(k) === nameOrId);
    if (name === undefined) throw new BackendError(`machine '${nameOrId}' not found`, "NOT_FOUND");
    this.machines.delete(name);
    return { deleted: name };
  }
  async exec(name: string, req: ExecOptions, _clientTimeoutMs?: number, ctx: CallCtx = {}) {
    this.calls.push({ op: "exec", name, args: req });
    // A backend that ignores the signal is a backend a cancel cannot reach.
    ctx.signal?.throwIfAborted();
    return this.execImpl(name, req);
  }
  async readFile(name: string, path: string) {
    this.calls.push({ op: "read", name, args: path });
    const f = this.files.get(`${name}:${path}`);
    if (!f) throw new BackendError(`read ${path}: not found`, "INTERNAL_ERROR");
    return f;
  }
  async writeFile(name: string, path: string, content: Buffer) {
    this.calls.push({ op: "write", name, args: path });
    this.files.set(`${name}:${path}`, content);
    return { path, size: content.length };
  }
  // Every line ever written, so a cursor test can add more between calls.
  logLines: string[] = ["line1", "line2"];
  async logs(name: string, opts: LogOptions): Promise<LogPage> {
    this.calls.push({ op: "logs", name, args: opts });
    const seen = opts.cursor === undefined ? undefined : Number(opts.cursor);
    const lines = seen === undefined ? this.logLines.slice(-opts.tail) : this.logLines.slice(seen);
    return { lines, cursor: String(this.logLines.length), truncated: false };
  }
  async pullImage(name: string, image: string): Promise<ImageInfo> {
    this.calls.push({ op: "pull", name, args: image });
    return { reference: image, digest: "sha256:0", size: 1, architecture: "arm64", os: "linux", layerCount: 1 };
  }
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...ConfigSchema.parse({}), runtimeDir: "/nonexistent", readyTimeoutSecs: 5, ...overrides };
}
