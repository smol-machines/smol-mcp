// The override table, checked against small specs rather than against a live
// binary, so the classification is asserted without a hypervisor.
import { describe, expect, it } from "vitest";
import { CLOUD_API_PATHS, LOCAL_API_PATHS, checkParity } from "../../src/parity.js";

const spec = (paths: Record<string, string[]>, version = "0.5.2") => ({
  info: { version },
  paths: Object.fromEntries(Object.entries(paths).map(([p, ms]) => [p, Object.fromEntries(ms.map((m) => [m, {}]))])),
});

describe("the parity override table", () => {
  it("reports a route this server calls that the spec has, and one it does not", () => {
    const r = checkParity(spec({ "/health": ["get"], "/api/v1/machines": ["get"] }), "local");
    expect(r.present).toContain("GET /health");
    // Everything else this server calls is absent from that tiny spec, so it
    // is missing rather than quietly assumed.
    expect(r.missing).toContain("POST /api/v1/machines/{name}/fork");
    expect(r.missing.length).toBe(LOCAL_API_PATHS.length - 2);
  });

  it("names the reason for every route it deliberately does not call", () => {
    const r = checkParity(spec({ "/api/v1/machines/{name}/export": ["post"], "/api/v1/machines/{id}/exec/stream": ["post"] }), "local");
    expect(r.skipped).toEqual([
      { route: "POST /api/v1/machines/{id}/exec/stream", why: "exec results are returned whole; nothing in the tool vocabulary streams a command" },
      {
        route: "POST /api/v1/machines/{name}/export",
        why: "needs a pushToken the spec itself describes as minted by the control plane, which a local user cannot mint",
      },
    ]);
    expect(r.unknown).toEqual([]);
  });

  it("reports a route nobody has ruled on as unknown, which is the point of the table", () => {
    // A capability arriving in a release should be visible here rather than
    // silently unexposed.
    const r = checkParity(spec({ "/api/v1/machines/{name}/teleport": ["post"] }), "local");
    expect(r.unknown).toEqual(["POST /api/v1/machines/{name}/teleport"]);
    expect(r.skipped).toEqual([]);
  });

  it("covers a whole subsystem by prefix rather than route by route", () => {
    const r = checkParity(spec({ "/api/v1/pools": ["get", "post"], "/api/v1/pools/{name}/leases": ["post"] }), "local");
    expect(r.unknown).toEqual([]);
    expect(r.skipped.map((s) => s.route).sort()).toEqual(["GET /api/v1/pools", "POST /api/v1/pools", "POST /api/v1/pools/{name}/leases"]);
  });

  it("separates a route the cloud spec omits from one that is genuinely gone", () => {
    // The published cloud openapi lists neither fork nor the checkpoint
    // routes, and fork exists and answers 201. Reporting it as missing every
    // time would bury a route that really had been withdrawn.
    const r = checkParity(spec({ "/v1/account": ["get"] }), "cloud");
    expect(r.undocumented).toEqual(["POST /v1/machines/{id}/fork"]);
    expect(r.missing).not.toContain("POST /v1/machines/{id}/fork");
    expect(r.missing.length).toBe(CLOUD_API_PATHS.length - 2);
  });

  it("does not read the spec's own version as the product version", () => {
    // It is hardcoded at 0.5.2 on a v1.14.5 binary.
    expect(checkParity(spec({}, "0.5.2"), "local").specVersion).toBe("0.5.2");
  });
});
