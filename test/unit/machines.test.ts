import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBackend, testConfig } from "./fake-backend.js";
import { StateFile } from "../../src/local/state.js";
import { cleanupEphemeral, createMachine, networkPolicy, runOnce, waitReady, writeFile, KEEPALIVE_CMD } from "../../src/machines.js";

describe("waitReady", () => {
  it("returns once an exec echoes the nonce, and counts the attempts", async () => {
    const b = new FakeBackend();
    let n = 0;
    b.execImpl = async (_name, req) => {
      n += 1;
      // The gap this guards: exit 1 with empty output, then ready.
      if (n < 3) return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: `${req.command[1]}\n`, stderr: "" };
    };
    const r = await waitReady(b, "m", 30, Date.now, async () => {});
    expect(r.attempts).toBe(3);
  });

  it("fails with NOT_READY at the deadline, carrying the last exec result", async () => {
    const b = new FakeBackend();
    b.execImpl = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    let t = 0;
    const now = () => (t += 1000);
    await expect(waitReady(b, "m", 3, now, async () => {})).rejects.toMatchObject({ code: "NOT_READY", message: expect.stringContaining("exit 1") });
  });

  it("gives up at once on NOT_FOUND", async () => {
    const b = new FakeBackend();
    b.execImpl = async () => {
      throw new (await import("../../src/backend.js")).BackendError("machine 'm' not found", "NOT_FOUND");
    };
    await expect(waitReady(b, "m", 30, Date.now, async () => {})).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("writeFile waits for readiness", () => {
  it("uploads only after an exec has returned a value (constraint a)", async () => {
    const b = new FakeBackend();
    let n = 0;
    b.execImpl = async (_name, req) => {
      n += 1;
      return n < 2 ? { exitCode: 1, stdout: "", stderr: "" } : { exitCode: 0, stdout: `${req.command[1]}\n`, stderr: "" };
    };
    const cfg = testConfig({ readyTimeoutSecs: 30 });
    // Fast pause: patch via a very small timeout budget is not needed, the fake returns ready on the 2nd exec.
    await writeFile({ backend: b, cfg, state: undefined }, "m", "/tmp/x", Buffer.from("hi"));
    const ops = b.calls.map((c) => c.op);
    const lastExec = ops.lastIndexOf("exec");
    const write = ops.indexOf("write");
    expect(write).toBeGreaterThan(lastExec);
    expect(ops.filter((o) => o === "exec")).toHaveLength(2);
  });
});

describe("createMachine", () => {
  it("names ephemeral machines with the prefix, records them, sends the keepalive cmd and the tethered defaults", async () => {
    const b = new FakeBackend();
    b.execImpl = async (_n, req) => ({ exitCode: 0, stdout: `${req.command[1]}\n`, stderr: "" });
    const state = new StateFile(join(mkdtempSync(join(tmpdir(), "smol-mcp-st-")), "machines.json"));
    const cfg = testConfig();
    const r = await createMachine({ backend: b, cfg, state }, { image: "alpine" });
    expect(r.machine.name.startsWith("mcp-")).toBe(true);
    expect(r.ephemeral).toBe(true);
    expect(r.ready).toBe(true);
    expect(state.read().machines.map((m) => m.name)).toEqual([r.machine.name]);
    const create = b.calls.find((c) => c.op === "create")?.args as Record<string, unknown>;
    expect(create.cpus).toBe(2);
    expect(create.memoryMb).toBe(2048);
    expect(create.network).toEqual({ mode: "open" });
    expect(create.cmd).toEqual(KEEPALIVE_CMD);
  });

  it("does not record a machine whose name lacks the prefix", async () => {
    const b = new FakeBackend();
    b.execImpl = async (_n, req) => ({ exitCode: 0, stdout: `${req.command[1]}\n`, stderr: "" });
    const state = new StateFile(join(mkdtempSync(join(tmpdir(), "smol-mcp-st-")), "machines.json"));
    const r = await createMachine({ backend: b, cfg: testConfig(), state }, { image: "alpine", name: "keep-me", start: false });
    expect(r.ephemeral).toBe(false);
    expect(r.ready).toBe(false);
    expect(state.read().machines).toEqual([]);
  });
});

describe("runOnce", () => {
  it("is create, start, exec, delete on the plain path", async () => {
    const b = new FakeBackend();
    b.execImpl = async (_n, req) => ({ exitCode: req.command[0] === "echo" ? 0 : 7, stdout: req.command[0] === "echo" ? `${req.command[1]}\n` : "hello\n", stderr: "" });
    const r = await runOnce({ backend: b, cfg: testConfig(), state: undefined }, { image: "alpine", command: ["sh", "-c", "echo hello; exit 7"] });
    expect(r.exitCode).toBe(7);
    expect(r.stdout).toBe("hello\n");
    expect(r.machine.startsWith("mcp-once-")).toBe(true);
    const ops = b.calls.map((c) => c.op);
    expect(ops[0]).toBe("create");
    expect(ops[1]).toBe("start");
    expect(ops.at(-1)).toBe("delete");
    expect(b.machines.size).toBe(0);
  });

  it("still deletes the machine when the command times out or the exec throws", async () => {
    const b = new FakeBackend();
    let execs = 0;
    b.execImpl = async (_n, req) => {
      execs += 1;
      if (req.command[0] === "echo") return { exitCode: 0, stdout: `${req.command[1]}\n`, stderr: "" };
      return { exitCode: 124, stdout: "", stderr: "\ncommand timed out after 2000ms" };
    };
    const r = await runOnce({ backend: b, cfg: testConfig(), state: undefined }, { image: "alpine", command: ["sleep", "999"], timeoutSecs: 2 });
    expect(r.timedOut).toBe(true);
    expect(b.machines.size).toBe(0);
    expect(execs).toBe(2);

    const b2 = new FakeBackend();
    b2.execImpl = async () => {
      throw new Error("socket hang up");
    };
    await expect(runOnce({ backend: b2, cfg: testConfig({ readyTimeoutSecs: 0 }), state: undefined }, { image: "alpine", command: "true" })).rejects.toThrow(/did not become ready/);
    expect(b2.machines.size).toBe(0);
    expect(b2.calls.at(-1)?.op).toBe("delete");
  });

  it("takes the local network default from config and blocks by default on cloud", async () => {
    const ready = async (_n: string, req: { command: string[] }) => ({ exitCode: 0, stdout: `${req.command[1] ?? ""}\n`, stderr: "" });
    const local = new FakeBackend("local");
    local.execImpl = ready;
    await runOnce({ backend: local, cfg: testConfig({ runOnceNetwork: "blocked" }), state: undefined }, { image: "alpine", command: "true" });
    expect((local.calls[0]?.args as { network: unknown }).network).toEqual({ mode: "blocked" });

    // No config knob decides this one: an untrusted command on a billed
    // fleet gets no egress unless the caller names an allow-list.
    const cloud = new FakeBackend("cloud");
    cloud.execImpl = ready;
    await runOnce({ backend: cloud, cfg: testConfig(), state: undefined }, { image: "alpine", command: "true" });
    expect((cloud.calls[0]?.args as { network: unknown }).network).toEqual({ mode: "blocked" });
  });

  it("sends a ttlSeconds backstop so a killed server cannot leave a machine billing", async () => {
    const b = new FakeBackend("cloud");
    b.execImpl = async (_n, req) => ({ exitCode: 0, stdout: `${req.command[1] ?? ""}\n`, stderr: "" });
    await runOnce({ backend: b, cfg: testConfig({ ephemeralTtlSecs: 600 }), state: undefined }, { image: "alpine", command: "true" });
    expect((b.calls[0]?.args as { ttlSeconds: number }).ttlSeconds).toBe(600);
  });
});

describe("cleanupEphemeral", () => {
  it("deletes prefixed machines recorded by this pid or a dead pid, never others", async () => {
    const b = new FakeBackend();
    const open = { image: "a", cpus: 1, memoryMb: 1, network: { mode: "open" as const } };
    await b.createMachine({ name: "mcp-mine", ...open });
    await b.createMachine({ name: "mcp-dead", ...open });
    await b.createMachine({ name: "mcp-other", ...open });
    await b.createMachine({ name: "keep", ...open });
    const state = new StateFile(join(mkdtempSync(join(tmpdir(), "smol-mcp-st-")), "machines.json"));
    state.add("mcp-mine");
    state.add("mcp-dead", 999999999);
    state.add("keep");
    b.calls.length = 0;
    const r = await cleanupEphemeral({ backend: b, cfg: testConfig(), state });
    expect(r.deleted.sort()).toEqual(["mcp-dead", "mcp-mine"]);
    expect(r.failed).toEqual([]);
    expect([...b.machines.keys()].sort()).toEqual(["keep", "mcp-other"]);
    // A machine already gone is dropped from the state without an error.
    state.add("mcp-gone");
    const r2 = await cleanupEphemeral({ backend: b, cfg: testConfig(), state });
    expect(r2.failed).toEqual([]);
    expect(state.read().machines.map((m) => m.name)).toEqual(["keep"]);
  });
});

describe("networkPolicy", () => {
  // A named allow-list that is silently replaced by the mode word is the
  // failure nobody sees until the guest reaches the internet.
  it("lets an allow-list win over the mode word", () => {
    expect(networkPolicy({ network: "open", allowHosts: ["example.com"] }, "blocked")).toEqual({ mode: "allow", hosts: ["example.com"], cidrs: [] });
    expect(networkPolicy({ allowCidrs: ["10.0.0.0/8"] }, "open")).toEqual({ mode: "allow", hosts: [], cidrs: ["10.0.0.0/8"] });
  });

  it("falls back only when no list was given", () => {
    expect(networkPolicy({}, "blocked")).toEqual({ mode: "blocked" });
    expect(networkPolicy({ network: "open" }, "blocked")).toEqual({ mode: "open" });
    expect(networkPolicy({ allowHosts: [] }, "blocked")).toEqual({ mode: "blocked" });
  });
});
