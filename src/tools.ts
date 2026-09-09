// Tool vocabulary and schemas. One vocabulary for both targets: every tool
// takes `target`, and the two backends normalise their own API's shapes.
import { z } from "zod";

export const TargetSchema = z
  .enum(["local", "cloud"])
  .default("local")
  .describe("Which fleet to talk to. local is smolvm serve on this host; cloud is smol cloud at SMOL_CLOUD_URL.");

const name = z.string().min(1).describe("Machine name");
const command = z
  .union([z.array(z.string()).min(1), z.string().min(1)])
  .describe("argv array, or a string run with sh -c");
const envMap = z.record(z.string(), z.string()).optional().describe("Environment variables");
const network = z
  .enum(["open", "blocked"])
  .optional()
  .describe("Egress mode. Local: blocked is refused when the image still has to be pulled from a registry, so an image machine needs open or an allow-list. Cloud: blocked is sent as an empty allow-list, which is enforced.");
const allowHosts = z.array(z.string()).optional().describe("Egress allow-list of hostnames. Overrides network. Local only: the cloud API takes CIDRs.");
const allowCidrs = z.array(z.string()).optional().describe("Egress allow-list of CIDR ranges. Overrides network.");

export const toolInputs = {
  "list-machines": { target: TargetSchema },
  "get-machine": { target: TargetSchema, name },
  "create-machine": {
    target: TargetSchema,
    name: z.string().min(1).optional().describe("Machine name. Omitted: an ephemeral mcp-<id> name, deleted when this server exits. A name without the mcp- prefix persists."),
    image: z.string().min(1).describe("OCI image reference, e.g. alpine or python:3.12-alpine"),
    cpus: z.number().int().positive().optional(),
    memoryMb: z.number().int().positive().optional(),
    network,
    allowHosts,
    allowCidrs,
    cmd: z.array(z.string()).optional().describe("Workload command. Default keeps the container alive (sleep loop). Local only; the cloud create request has no such field."),
    env: envMap,
    start: z.boolean().optional().describe("Start and wait for readiness (default true)"),
  },
  "run-command": {
    target: TargetSchema,
    name,
    command,
    timeoutSecs: z.number().int().positive().optional(),
    workdir: z.string().optional(),
    env: envMap,
    stdin: z.string().optional(),
  },
  "run-once": {
    target: TargetSchema,
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
    target: TargetSchema,
    name,
    path: z.string().min(1).describe("Absolute path inside the machine"),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  },
  "write-file": {
    target: TargetSchema,
    name,
    path: z.string().min(1).describe("Absolute path inside the machine"),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  },
  "stop-machine": { target: TargetSchema, name },
  "delete-machine": { target: TargetSchema, name },
  "machine-logs": { target: TargetSchema, name, tail: z.number().int().positive().optional() },
  "pull-image": { target: TargetSchema, name, image: z.string().min(1) },
} as const;

export type ToolName = keyof typeof toolInputs;

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
  "run-command": "Run a command in a running machine. exitCode comes from the guest; a failing command is not an error.",
  "run-once": "Create a throwaway machine from an image, run one command, and delete the machine even on timeout.",
  "read-file": "Read a file from a machine.",
  "write-file": "Write a file into a machine. Waits until the workload container runs so the file is not lost.",
  "stop-machine": "Stop a running machine (it can be started again with create-machine's name or the CLI).",
  "delete-machine": "Delete a machine, running or not.",
  "machine-logs": "Tail the machine's console log. Local only.",
  "pull-image": "Pull an image into a running machine's local cache. Local only.",
};
