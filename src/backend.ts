// The target-agnostic surface every tool is written against. Both targets
// implement it; the two APIs disagree about names, shapes and even about what
// identifies a machine, so the normalising happens here rather than in a tool.
import type { ImageInfo } from "./api.js";

// Egress policy, expressed once for both targets.
//   open     unrestricted outbound
//   blocked  no outbound at all
//   allow    outbound only to the listed hosts or CIDRs
// The local API refuses `blocked` for a machine whose image still has to be
// pulled from a registry, so the two targets do not have the same default;
// see the README.
export interface NetworkPolicy {
  mode: "open" | "blocked" | "allow";
  hosts?: string[];
  cidrs?: string[];
}

export const OPEN_NETWORK: NetworkPolicy = { mode: "open" };

// One machine, in the shape the tools return. `id` is what the backend's own
// routes take (a name locally, a mach-... id on cloud) and `name` is what a
// person typed; locally they are the same string.
export interface MachineView {
  id: string;
  name: string;
  state: string;
  cpus: number;
  memoryMb: number;
  network: string;
  createdAt: number;
  image: string | null;
  pid: number | null;
}

// A published guest port. `host` is the port on the host that forwards to it
// and is local only: the cloud control plane allocates its own and answers
// with an ingress URL.
export interface PortSpec {
  guest: number;
  host?: number | undefined;
}

// A host directory attached to the machine. Local only: the cloud API mounts
// named volumes, not host paths, and this server has no host to mount from
// when the fleet is somewhere else.
export interface MountSpec {
  source: string;
  target: string;
  readonly?: boolean | undefined;
}

export interface CreateOptions {
  name: string;
  image: string;
  cpus: number;
  memoryMb: number;
  network: NetworkPolicy;
  ports?: PortSpec[];
  mounts?: MountSpec[];
  // Size of the machine's own disk. Local calls it storageGb; the cloud
  // create request carries it as resources.diskGb.
  storageGb?: number;
  // Local only: the cloud machine has no separate overlay disk.
  overlayGb?: number;
  // Workload command. Local only: the cloud create request has no such field
  // and the cloud client drops it (see CloudClient.createMachine).
  cmd?: string[];
  env?: Record<string, string>;
  // Control-plane backstop that deletes the machine even if this process dies.
  // Cloud only; the local API has no equivalent, which is why the local target
  // keeps a state file instead.
  ttlSeconds?: number;
  // Stop the machine after this many seconds with nothing dispatched to it.
  // Cloud only, and the cheaper half of the backstop: ttlSeconds caps the
  // bill at the hour, this one ends it at the first idle window.
  autoStopSeconds?: number;
  // Delete the machine once it stops rather than keeping it stopped. Cloud
  // only, and what turns an auto-stop into a cleanup.
  ephemeral?: boolean;
}

export interface ExecOptions {
  command: string[];
  timeoutSecs?: number;
  workdir?: string;
  env?: Record<string, string>;
  stdin?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  // Set when the API cut the stream itself. The cloud API caps a text stream
  // at 1 MiB and says so in these two fields; the local API does not cap and
  // does not carry them.
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

// What the caller can still say once a call is under way. The protocol has
// exactly one thing to say, and it is "stop": a client that cancels a request
// releases nothing unless the abort reaches the socket, so every backend
// method takes this and every backend call passes it on.
export interface CallCtx {
  signal?: AbortSignal | undefined;
}

export interface LogOptions {
  // Lines from the end, when there is no cursor.
  tail: number;
  // The caller's abort, carried in the options rather than beside them. A log
  // follow is the one call that already has an options object, and two
  // branches each claiming the next positional parameter is what made this a
  // collision rather than an addition.
  ctx?: CallCtx | undefined;
  // Where the last page ended. Opaque, and issued by the target that will be
  // asked to resume from it: neither log route takes a "since", so the two
  // targets resume by different means and neither cursor means anything to
  // the other.
  cursor?: string | undefined;
}

export interface LogPage {
  lines: string[];
  // Pass this back to get what has arrived since. Always present, so a
  // follower never has to guess whether it can resume.
  cursor: string;
  // Set when lines were dropped to stay inside the output budget.
  truncated: boolean;
}

export interface MachineBackend {
  readonly target: "local" | "cloud";
  listMachines(ctx?: CallCtx): Promise<MachineView[]>;
  getMachine(name: string, ctx?: CallCtx): Promise<MachineView>;
  createMachine(opts: CreateOptions, ctx?: CallCtx): Promise<MachineView>;
  startMachine(name: string, ctx?: CallCtx): Promise<MachineView>;
  stopMachine(name: string, ctx?: CallCtx): Promise<MachineView>;
  // Returns the name that was deleted, plus the settled bill where the API
  // reports one (cloud does, on DELETE ...?includeUsage=true; local does not).
  deleteMachine(name: string, ctx?: CallCtx): Promise<{ deleted: string; usageMicros?: number }>;
  exec(name: string, req: ExecOptions, clientTimeoutMs?: number, ctx?: CallCtx): Promise<ExecResult>;
  readFile(name: string, path: string, ctx?: CallCtx): Promise<Buffer>;
  writeFile(name: string, path: string, content: Buffer, ctx?: CallCtx): Promise<{ path: string; size: number }>;
  logs(name: string, opts: LogOptions): Promise<LogPage>;
  pullImage(name: string, image: string, ctx?: CallCtx): Promise<ImageInfo>;
}

export class BackendError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
}
