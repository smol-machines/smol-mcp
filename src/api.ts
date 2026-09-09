// Response shapes of the local API, taken from `smolvm serve openapi` at
// v1.14.3 and narrowed to the fields this server reads. Parsing is lenient on
// extra fields because the spec grows with every release.
import { z } from "zod";

export const MachineInfoSchema = z.looseObject({
  name: z.string(),
  state: z.string(),
  cpus: z.number(),
  memoryMb: z.number(),
  network: z.boolean(),
  allowedHosts: z.array(z.string()).nullish(),
  allowedCidrs: z.array(z.string()).nullish(),
  pid: z.number().nullish(),
  createdAt: z.number(),
  storageGb: z.number().nullish(),
  overlayGb: z.number().nullish(),
});
export type MachineInfo = z.infer<typeof MachineInfoSchema>;

export const ListMachinesResponseSchema = z.object({ machines: z.array(MachineInfoSchema) });

export const ExecResponseSchema = z.looseObject({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutB64: z.string().optional(),
  stderrB64: z.string().optional(),
});
export type ExecResponse = z.infer<typeof ExecResponseSchema>;

export const FileUploadResponseSchema = z.object({ path: z.string(), size: z.number() });
export const DeleteResponseSchema = z.object({ deleted: z.string() });
export const HealthResponseSchema = z.looseObject({ status: z.string(), version: z.string() });
export const ApiErrorResponseSchema = z.object({ error: z.string(), code: z.string() });

export const ImageInfoSchema = z.looseObject({
  reference: z.string(),
  digest: z.string(),
  size: z.number(),
  architecture: z.string(),
  os: z.string(),
  layerCount: z.number(),
});
export type ImageInfo = z.infer<typeof ImageInfoSchema>;
export const PullImageResponseSchema = z.object({ image: ImageInfoSchema });

// Request bodies. The create field names are the schema's (`network`,
// `memoryMb`, `cmd`), not the CLI's flags. ExecRequest is `deny_unknown_fields`
// on the server, so a mis-cased safety field is a hard 400 rather than a
// command left running with no timeout.
export interface CreateMachineRequest {
  name: string;
  image: string;
  cpus: number;
  memoryMb: number;
  network: boolean;
  allowedHosts?: string[];
  allowedCidrs?: string[];
  cmd?: string[];
  env?: { name: string; value: string }[];
}

export interface ExecRequest {
  command: string[];
  timeoutSecs?: number;
  workdir?: string;
  env?: { name: string; value: string }[];
  stdin?: string;
}
