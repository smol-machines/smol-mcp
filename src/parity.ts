// What this server calls, and what it deliberately does not.
//
// Parity is stated by the paths, not by the spec's `info.version`, which is
// hardcoded (it says 0.5.2 on a v1.14.5 binary) and must never be used for
// this.
//
// The second half of this file is the part that earns its keep: every route
// either API publishes that this server does not call, with the reason. A
// route in neither list is reported as `unknown`, so a capability appearing
// in a release is visible here rather than silently unexposed.
//
// The tools are hand written and not generated from either spec, because
// three published entries do not describe the running service: the cloud
// snapshot route is documented 200 and answers 501, the cloud export entry
// carries no request body at all, and the local spec has no checkpoint route
// while the product has the feature. The published cloud openapi also lists
// neither `fork` nor the checkpoint routes, and both exist and answer.

export interface Route {
  method: "get" | "post" | "put" | "delete";
  path: string;
}

export interface SkippedRoute extends Route {
  why: string;
}

export const LOCAL_API_PATHS: Route[] = [
  { method: "get", path: "/health" },
  { method: "get", path: "/api/v1/machines" },
  { method: "post", path: "/api/v1/machines" },
  { method: "get", path: "/api/v1/machines/{name}" },
  { method: "delete", path: "/api/v1/machines/{name}" },
  { method: "post", path: "/api/v1/machines/{name}/start" },
  { method: "post", path: "/api/v1/machines/{name}/stop" },
  { method: "post", path: "/api/v1/machines/{name}/fork" },
  { method: "post", path: "/api/v1/machines/{id}/exec" },
  { method: "get", path: "/api/v1/machines/{id}/files/{path}" },
  { method: "put", path: "/api/v1/machines/{id}/files/{path}" },
  { method: "get", path: "/api/v1/machines/{id}/logs" },
  { method: "post", path: "/api/v1/machines/{id}/images/pull" },
];

export const LOCAL_NOT_CALLED: SkippedRoute[] = [
  {
    method: "post",
    path: "/api/v1/machines/{name}/export",
    why: "needs a pushToken the spec itself describes as minted by the control plane, which a local user cannot mint",
  },
  {
    method: "post",
    path: "/api/v1/machines/{name}/branches",
    why: "the plural form of the branch route; branch-machine calls /fork, which is the one exercised on 1.14.5",
  },
  { method: "post", path: "/api/v1/machines/{name}/fork-release", why: "releases a held fork-pool slot, and this server has no pool vocabulary" },
  { method: "post", path: "/api/v1/machines/{name}/sync", why: "synchronises staged mounts, and mounts are a create-time argument here" },
  { method: "post", path: "/api/v1/machines/{name}/resize", why: "expand only, and no tool asks for a machine to grow after it exists" },
  { method: "post", path: "/api/v1/machines/{id}/exec/stream", why: "exec results are returned whole; nothing in the tool vocabulary streams a command" },
  { method: "post", path: "/api/v1/machines/{id}/run", why: "runs a command in an image; run-once composes create, start, exec and delete instead" },
  { method: "get", path: "/api/v1/machines/{id}/images", why: "lists a machine's image cache, which no tool reports" },
  { method: "get", path: "/api/v1/machines/{name}/egress-events", why: "an egress audit trail, which belongs to a security surface this server does not have" },
  { method: "get", path: "/capacity", why: "node capacity, which is an operator question rather than an agent one" },
];

// Two whole subsystems rather than single routes.
export const LOCAL_NOT_CALLED_PREFIXES: { prefix: string; why: string }[] = [
  { prefix: "/api/v1/pools", why: "fork pools keep pre-booted workers for batch workloads, which no tool here exposes" },
  { prefix: "/api/v1/rollout-executors", why: "a fleet-management surface, not an agent one" },
];

export const CLOUD_API_PATHS: Route[] = [
  { method: "get", path: "/v1/account" },
  { method: "get", path: "/v1/machines" },
  { method: "post", path: "/v1/machines" },
  { method: "get", path: "/v1/machines/{id}" },
  { method: "delete", path: "/v1/machines/{id}" },
  { method: "post", path: "/v1/machines/{id}/start" },
  { method: "post", path: "/v1/machines/{id}/stop" },
  { method: "post", path: "/v1/machines/{id}/exec" },
  { method: "post", path: "/v1/machines/{id}/fork" },
  { method: "get", path: "/v1/machines/{id}/events" },
  { method: "get", path: "/v1/machines/{id}/files" },
  { method: "post", path: "/v1/machines/{id}/files" },
];

export const CLOUD_NOT_CALLED: SkippedRoute[] = [
  {
    method: "post",
    path: "/v1/machines/{id}/export",
    why: "the spec entry carries no request body and nothing anywhere tests it, so there is no shape to code against",
  },
  { method: "post", path: "/v1/machines/{id}/snapshot", why: "documented 200, answers 501 telling the caller to export instead; never call it" },
  { method: "get", path: "/v1/volumes", why: "volumes are not built on this service; the local equivalent is the mounts argument" },
  { method: "post", path: "/v1/volumes", why: "volumes are not built on this service; the local equivalent is the mounts argument" },
  {
    method: "post",
    path: "/v1/machines/{id}/checkpoints",
    why: "capture failed on the service side every time it was tried, so no tool ships until it works",
  },
  { method: "get", path: "/v1/machines/{id}/checkpoints", why: "listing is only useful alongside a capture that works" },
  { method: "post", path: "/v1/checkpoints/{id}/restore", why: "restore is only reachable through a capture that works" },
  { method: "delete", path: "/v1/checkpoints/{id}", why: "failed on storage cleanup when it was tried" },
  { method: "post", path: "/v1/machines/{id}/fork-batch", why: "batch branching, which the tool vocabulary does not express" },
  { method: "get", path: "/v1/machines/{id}/lineage", why: "the branch ancestry of a machine, which no tool reports" },
  { method: "get", path: "/v1/machines/{id}/sessions", why: "a session keeps a working directory and environment across execs; run-command is one shot" },
  { method: "post", path: "/v1/machines/{id}/sessions", why: "a session keeps a working directory and environment across execs; run-command is one shot" },
  { method: "post", path: "/v1/machines/{id}/code", why: "a code-oriented surface with no counterpart on the local target" },
  { method: "get", path: "/v1/machines/{id}/connect/{port}", why: "the authenticated bridge answers GET and HEAD only, so no MCP client can speak through it" },
];

// Routes this server calls that the published spec does not list. They exist
// and answer; the document is behind the service. Listing them here keeps
// `missing` meaningful, because a route that really has gone would otherwise
// be lost among these two.
export const CLOUD_UNDOCUMENTED: Route[] = [{ method: "post", path: "/v1/machines/{id}/fork" }];

export const CLOUD_NOT_CALLED_PREFIXES: { prefix: string; why: string }[] = [
  { prefix: "/v1/apps", why: "deploys long-lived services, a different product from a machine an agent borrows" },
  { prefix: "/v1/nodes", why: "node administration, not an agent surface" },
  { prefix: "/v1/tenants", why: "tenant administration, not an agent surface" },
  { prefix: "/v1/apikeys", why: "key management; this server is given a key rather than minting one" },
  { prefix: "/v1/tokens", why: "key management; this server is given a key rather than minting one" },
  { prefix: "/v1/plans", why: "billing administration" },
  { prefix: "/v1/billing", why: "billing administration" },
  { prefix: "/v1/pools", why: "pre-booted worker pools, which no tool here exposes" },
  { prefix: "/v1/operations", why: "long-running operation polling, which no call here returns" },
  { prefix: "/v1/usage", why: "the settled bill comes back on the delete instead" },
  { prefix: "/v1/volumes", why: "volumes are not built on this service; the local equivalent is the mounts argument" },
  { prefix: "/v1/machines/{id}/sessions/", why: "a session keeps state across execs; run-command is one shot" },
  { prefix: "/livez", why: "a liveness probe for the service, not for a caller" },
  { prefix: "/readyz", why: "a readiness probe for the service, not for a caller" },
  { prefix: "/metrics", why: "service metrics, not an agent surface" },
  { prefix: "/health", why: "a liveness probe for the service, not for a caller" },
];

export interface ParityReport {
  // Routes this server calls that the spec has.
  present: string[];
  // Routes this server calls that the spec does not have. An entry here is a
  // call that will fail against this build.
  missing: string[];
  // Routes the spec has that this server deliberately does not call.
  skipped: { route: string; why: string }[];
  // Routes the spec has that are in neither list. One appearing here is the
  // point of the exercise: a capability nobody has ruled on yet.
  unknown: string[];
  // Routes this server calls that the spec does not list, and that are known
  // to exist anyway.
  undocumented: string[];
  specVersion: string;
}

function key(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function checkParity(spec: unknown, side: "local" | "cloud" = "local"): ParityReport {
  const s = spec as { paths?: Record<string, Record<string, unknown>>; info?: { version?: string } };
  const called = side === "local" ? LOCAL_API_PATHS : CLOUD_API_PATHS;
  const notCalled = side === "local" ? LOCAL_NOT_CALLED : CLOUD_NOT_CALLED;
  const prefixes = side === "local" ? LOCAL_NOT_CALLED_PREFIXES : CLOUD_NOT_CALLED_PREFIXES;

  const undocumentedKeys = new Set((side === "cloud" ? CLOUD_UNDOCUMENTED : []).map((r) => key(r.method, r.path)));
  const present: string[] = [];
  const missing: string[] = [];
  const undocumented: string[] = [];
  for (const { method, path } of called) {
    const k = key(method, path);
    if (s.paths?.[path]?.[method]) present.push(k);
    else if (undocumentedKeys.has(k)) undocumented.push(k);
    else missing.push(k);
  }

  const skipped: { route: string; why: string }[] = [];
  const unknown: string[] = [];
  const calledKeys = new Set(called.map((r) => key(r.method, r.path)));
  const skipByKey = new Map(notCalled.map((r) => [key(r.method, r.path), r.why]));
  for (const [path, methods] of Object.entries(s.paths ?? {})) {
    for (const method of Object.keys(methods)) {
      if (!["get", "post", "put", "delete"].includes(method)) continue;
      const k = key(method, path);
      if (calledKeys.has(k)) continue;
      const why = skipByKey.get(k) ?? prefixes.find((p) => path.startsWith(p.prefix))?.why;
      if (why !== undefined) skipped.push({ route: k, why });
      else unknown.push(k);
    }
  }

  return {
    present,
    missing,
    skipped: skipped.sort((a, b) => a.route.localeCompare(b.route)),
    unknown: unknown.sort(),
    undocumented: undocumented.sort(),
    specVersion: s.info?.version ?? "",
  };
}
