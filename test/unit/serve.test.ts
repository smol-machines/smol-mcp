// The local target's preflight. Every case here was met inside a smol machine
// guest, where the first local tool call used to spend the serve-start timeout
// waiting for a binary that does not exist and then blamed the timeout.
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { isOrphan, localUnavailable, serveEnv } from "../../src/local/serve.js";
import type { HostChecks, ServeHandle } from "../../src/local/serve.js";
import { ServePool } from "../../src/local/pool.js";
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

describe("the shared serve, by reference count", () => {
  const fakeHandle = (stopped: string[]): ServeHandle => ({
    client: null as never,
    url: "unix:///tmp/fake.sock",
    owned: true,
    version: "test",
    stop: async () => {
      stopped.push("stopped");
    },
  });

  it("starts one serve for many sessions and stops it only when the last one lets go", async () => {
    // Executed against a fake serve before this: the session that spawned it
    // stopped it on its own close, and the next call from a session still
    // holding a client to that socket was ECONNREFUSED.
    const pool = new ServePool();
    const stopped: string[] = [];
    let starts = 0;
    const start = async () => {
      starts += 1;
      return fakeHandle(stopped);
    };
    const a = await pool.acquire("k", start);
    const b = await pool.acquire("k", start);
    const c = await pool.acquire("k", start);
    expect(starts).toBe(1);
    expect(pool.refs("k")).toBe(3);

    await a.stop();
    // A release repeated is not a second release.
    await a.stop();
    await b.stop();
    expect(stopped).toEqual([]);
    expect(pool.refs("k")).toBe(1);

    await c.stop();
    expect(stopped).toEqual(["stopped"]);
    expect(pool.refs("k")).toBe(0);
  });

  it("keeps two runtime directories apart", async () => {
    const pool = new ServePool();
    const stopped: string[] = [];
    let starts = 0;
    const start = async () => {
      starts += 1;
      return fakeHandle(stopped);
    };
    await pool.acquire("one", start);
    await pool.acquire("two", start);
    expect(starts).toBe(2);
  });

  it("does not leave a failed start in the pool for the next session to inherit", async () => {
    const pool = new ServePool();
    let attempts = 0;
    const failing = async (): Promise<ServeHandle> => {
      attempts += 1;
      throw new Error("no hypervisor");
    };
    await expect(pool.acquire("k", failing)).rejects.toThrow(/no hypervisor/);
    await expect(pool.acquire("k", failing)).rejects.toThrow(/no hypervisor/);
    expect(attempts).toBe(2);
    expect(pool.refs("k")).toBe(0);
  });
});

describe("the environment the serve child gets", () => {
  it("carries what a hypervisor needs and neither token", () => {
    // The child used to get process.env whole, so a hypervisor that reads
    // neither of them held the cloud account key and this server's own HTTP
    // token in its environment for as long as it ran.
    const env = serveEnv({
      PATH: "/usr/bin",
      HOME: "/home/a",
      SMOLVM_LOG: "debug",
      SMOL_CLOUD_TOKEN: "the-cloud-account-key",
      SMOL_MCP_AUTH_TOKEN: "the-http-token",
      AWS_SECRET_ACCESS_KEY: "something-else-entirely",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/a", SMOLVM_LOG: "debug" });
  });

  it("is an allow-list, so a new secret does not travel by default", () => {
    expect(serveEnv({ PATH: "/usr/bin", A_NEW_TOKEN_NOBODY_LISTED: "x" })).toEqual({ PATH: "/usr/bin" });
  });
});

describe("what counts as an orphaned serve", () => {
  const url = "unix:///tmp/x/api.sock";
  const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

  it("is a listening serve whose starter is gone", () => {
    expect(isOrphan({ pid: 10, owner: 11, url }, url, alive([10]))).toBe(true);
  });

  it("is not a serve another live process started", () => {
    // Found by a real run: reclaiming this one stopped the serve under the
    // instance that was still using it, and its next call was ENOENT on the
    // socket.
    expect(isOrphan({ pid: 10, owner: 11, url }, url, alive([10, 11]))).toBe(false);
  });

  it("is not a dead serve, and not one recorded for another address", () => {
    expect(isOrphan({ pid: 10, owner: 11, url }, url, alive([11]))).toBe(false);
    expect(isOrphan({ pid: 10, owner: 11, url: "unix:///tmp/other.sock" }, url, alive([10]))).toBe(false);
    expect(isOrphan(undefined, url, alive([10]))).toBe(false);
  });
});
