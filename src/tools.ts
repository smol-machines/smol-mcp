// Tool vocabulary and schemas. One vocabulary for both targets: the two
// backends normalise their own API's shapes behind it.
import { z } from "zod";
import type { TargetMode } from "./config.js";

export const TargetSchema = z
  .enum(["local", "cloud"])
  .describe("Which fleet to run this on. local is smolvm serve on this host; cloud is smol cloud at SMOL_CLOUD_URL. Required, with no default: the two fleets bill differently and a machine on one is invisible on the other.");

// The argument exists only when this process reaches both fleets. The
// declared type keeps it either way so one handler signature serves every
// mode; a handler reads it as possibly absent, because in a single-target
// mode it is not in the schema and no client can send it.
function targetArg(mode: TargetMode): { target: typeof TargetSchema } {
  return (mode === "both" ? { target: TargetSchema } : {}) as { target: typeof TargetSchema };
}

const name = z.string().min(1).describe("Machine name");
const command = z
  .union([z.array(z.string()).min(1), z.string().min(1)])
  .describe("argv array, or a string run with sh -c");
const envMap = z.record(z.string(), z.string()).optional().describe("Environment variables");
const network = z
  .enum(["open", "blocked"])
  .optional()
  .describe("Egress mode. Default open, except run-once on cloud which is blocked. Local: a blocked machine whose image still has to be pulled from a registry is refused by the API; pass open or an allow-list for that create. Cloud: blocked is sent as an allow-list of an unroutable range.");
const allowHosts = z.array(z.string()).optional().describe("Egress allow-list of hostnames. Overrides network. Local: sent as allowedHosts. Cloud: sent inside the same cidrs list the published schema names, alongside allowCidrs.");
const allowCidrs = z.array(z.string()).optional().describe("Egress allow-list of CIDR ranges. Overrides network.");

export function toolInputs(mode: TargetMode) {
  const target = targetArg(mode);
  return {
    "list-machines": { ...target },
    "get-machine": { ...target, name },
    "create-machine": {
      ...target,
      name: z.string().min(1).optional().describe("Machine name. Omitted: an ephemeral mcp-<id> name, deleted when this server exits. A name without the mcp- prefix persists."),
      image: z.string().min(1).describe("OCI image reference, e.g. alpine or python:3.12-alpine"),
      cpus: z.number().int().positive().optional(),
      memoryMb: z.number().int().positive().optional(),
      network,
      allowHosts,
      allowCidrs,
      ports: z
        .array(z.object({ guest: z.number().int().positive().describe("Port inside the machine"), host: z.number().int().positive().optional().describe("Port on the host. Local only, and the guest port by default; on cloud the control plane allocates the host side and answers with an ingress URL.") }))
        .optional()
        .describe("Guest ports to publish. On cloud a published port is reached through the machine's ingress or its authenticated connect route, and blocked egress is refused alongside one."),
      mounts: z
        .array(z.object({ source: z.string().min(1).describe("Host path"), target: z.string().min(1).describe("Path inside the machine"), readonly: z.boolean().optional() }))
        .optional()
        .describe("Host directories to attach. Local only: a cloud machine has no host filesystem to mount from."),
      storageGb: z.number().int().positive().optional().describe("Size of the machine's own disk in GiB. Sent as storageGb locally and as resources.diskGb on cloud."),
      overlayGb: z.number().int().positive().optional().describe("Overlay disk size in GiB. Local only: a cloud machine has one disk."),
      cmd: z.array(z.string()).optional().describe("Workload command. Default keeps the container alive (sleep loop). Local only; the cloud create request has no such field."),
      env: envMap,
      start: z.boolean().optional().describe("Start and wait for readiness (default true)"),
    },
    "run-command": {
      ...target,
      name,
      command,
      timeoutSecs: z.number().int().positive().optional(),
      workdir: z.string().optional(),
      env: envMap,
      stdin: z.string().optional(),
    },
    "run-once": {
      ...target,
      image: z.string().min(1),
      command,
      timeoutSecs: z.number().int().positive().optional(),
      workdir: z.string().optional(),
      env: envMap,
      stdin: z.string().optional(),
      cpus: z.number().int().positive().optional(),
      memoryMb: z.number().int().positive().optional(),
      network,
      allowHosts,
      allowCidrs,
    },
    "read-file": {
      ...target,
      name,
      path: z.string().min(1).describe("Absolute path inside the machine"),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
      offset: z.number().int().nonnegative().optional().describe("Byte to start at. Default 0."),
      length: z.number().int().positive().optional().describe("How many bytes to return. Default: to the end of the file, or as many as the output budget allows."),
    },
    "write-file": {
      ...target,
      name,
      path: z.string().min(1).describe("Absolute path inside the machine"),
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
    },
    "start-machine": {
      ...target,
      name,
      wait: z.boolean().optional().describe("Wait until commands run in the machine before returning (default true)"),
    },
    "stop-machine": { ...target, name },
    "delete-machine": { ...target, name },
    "machine-logs": { ...target, name, tail: z.number().int().positive().optional() },
    "pull-image": { ...target, name, image: z.string().min(1) },
  } as const;
}

export type ToolInputs = ReturnType<typeof toolInputs>;
export type ToolName = keyof ToolInputs;

export const commandResultOutput = {
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  truncated: z.boolean(),
  timedOut: z.boolean(),
};

export const machineOutput = {
  id: z.string(),
  name: z.string(),
  state: z.string(),
  cpus: z.number(),
  memoryMb: z.number(),
  network: z.string(),
  createdAt: z.number(),
  image: z.string().nullable(),
  pid: z.number().nullable(),
};

export const toolDescriptions: Record<ToolName, string> = {
  "list-machines": "List machines on the target.",
  "get-machine": "Get one machine's state and resources.",
  "create-machine": "Create a machine from an OCI image, start it, and wait until commands run in it.",
  "run-command": "Run a command in a machine. exitCode comes from the guest; a failing command is not an error. On cloud a stopped machine is started by the command and left running, and startedMachine says when that happened.",
  "run-once": "Create a throwaway machine from an image, run one command, and delete the machine even on timeout.",
  "read-file": "Read a file from a machine. On cloud a stopped machine is started by the read and left running, and startedMachine says when that happened.",
  "write-file": "Write a file into a machine. Waits until the workload container runs so the file is not lost. On cloud a stopped machine is started by the write and left running, and startedMachine says when that happened.",
  "start-machine": "Start a stopped machine and wait until commands run in it. This is the way back from stop-machine: create-machine on an existing name is a conflict on both targets.",
  "stop-machine": "Stop a running machine. start-machine starts it again.",
  "delete-machine": "Delete a machine, running or not.",
  "machine-logs": "Tail the machine's console log. Local only.",
  "pull-image": "Pull an image into a running machine's local cache. Local only.",
};
