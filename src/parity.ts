// Parity with the local API is stated by the paths this server calls, checked
// against `smolvm serve openapi`. The spec's info.version is hardcoded (it
// says 0.5.2 on v1.14.3) and must not be used for this.
export const LOCAL_API_PATHS: { method: "get" | "post" | "put" | "delete"; path: string }[] = [
  { method: "get", path: "/health" },
  { method: "get", path: "/api/v1/machines" },
  { method: "post", path: "/api/v1/machines" },
  { method: "get", path: "/api/v1/machines/{name}" },
  { method: "delete", path: "/api/v1/machines/{name}" },
  { method: "post", path: "/api/v1/machines/{name}/start" },
  { method: "post", path: "/api/v1/machines/{name}/stop" },
  { method: "post", path: "/api/v1/machines/{id}/exec" },
  { method: "get", path: "/api/v1/machines/{id}/files/{path}" },
  { method: "put", path: "/api/v1/machines/{id}/files/{path}" },
  { method: "get", path: "/api/v1/machines/{id}/logs" },
  { method: "post", path: "/api/v1/machines/{id}/images/pull" },
];

export interface ParityReport {
  present: string[];
  missing: string[];
  specVersion: string;
}

export function checkParity(spec: unknown): ParityReport {
  const s = spec as { paths?: Record<string, Record<string, unknown>>; info?: { version?: string } };
  const present: string[] = [];
  const missing: string[] = [];
  for (const { method, path } of LOCAL_API_PATHS) {
    const key = `${method.toUpperCase()} ${path}`;
    if (s.paths?.[path]?.[method]) present.push(key);
    else missing.push(key);
  }
  return { present, missing, specVersion: s.info?.version ?? "" };
}
