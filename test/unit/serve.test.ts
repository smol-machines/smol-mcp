// The local target's preflight. Every case here was met inside a smol machine
// guest, where the first local tool call used to spend the serve-start timeout
// waiting for a binary that does not exist and then blamed the timeout.
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { localUnavailable } from "../../src/local/serve.js";
import type { HostChecks } from "../../src/local/serve.js";
import { testConfig } from "./fake-backend.js";

const checks = (over: Partial<HostChecks> = {}): HostChecks => ({
  platform: "linux",
  exists: (p) => p === "/dev/kvm",
  onPath: () => true,
  ...over,
});

describe("localUnavailable", () => {
  it("passes a host that has a hypervisor and the binary", () => {
    expect(localUnavailable(testConfig(), checks())).toBeUndefined();
  });

  it("names the hypervisor, and nested virtualization, before the binary", () => {
    // A guest is missing both. Reporting the missing binary first would send
    // the reader to install smolvm inside the machine, which cannot help.
    const msg = localUnavailable(testConfig(), checks({ exists: () => false, onPath: () => false }));
    expect(msg).toMatch(/\/dev\/kvm/);
    expect(msg).toMatch(/smol machine guest/);
    expect(msg).toMatch(/target "cloud"/);
  });

  it("names the missing binary on a host that could otherwise run a VM", () => {
    const msg = localUnavailable(testConfig(), checks({ onPath: () => false }));
    expect(msg).toMatch(/'smolvm' is not on PATH/);
    expect(msg).toMatch(/target "cloud"/);
  });

  it("checks the path SMOLVM names rather than PATH", () => {
    const msg = localUnavailable(testConfig({ smolvm: "/opt/smolvm/bin/smolvm" }), checks({ onPath: () => true }));
    expect(msg).toMatch(/no smolvm binary at \/opt\/smolvm\/bin\/smolvm/);
  });

  it("does not look for /dev/kvm off Linux", () => {
    expect(localUnavailable(testConfig(), checks({ platform: "darwin", exists: () => false }))).toBeUndefined();
  });
});

describe("a server whose local target cannot start", () => {
  it("reports the reason once, and its shutdown is clean rather than a second failure", async () => {
    // Observed inside a smol machine: the local call correctly refused, and
    // then stdin EOF printed "cleanup failed" for a serve that never ran and
    // machines that were never created.
    const cfg = testConfig({ smolvm: "smolvm-that-is-not-installed", runtimeDir: mkdtempSync(join(tmpdir(), "smol-mcp-serve-")) });
    const app = await createServer({ cfg, log: () => {} });
    await expect(app.local()).rejects.toThrow(/local target is unavailable/);
    await expect(app.shutdown()).resolves.toEqual({ deleted: [], failed: [] });
  });
});
