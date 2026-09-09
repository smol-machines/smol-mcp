import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBackend, testConfig } from "./fake-backend.js";

// Every record in this file belongs to one session; the cross-session cases
// name their own.
const SESSION = "session-under-test";
import { StateFile } from "../../src/local/state.js";
import { KEEPALIVE_CMD, cleanupEphemeral, createMachine, networkPolicy, runCommand, runOnce, startMachine, waitReady, writeFile } from "../../src/machines.js";

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
    await writeFile({ backend: b, cfg, state: undefined, session: SESSION }, "m", "/tmp/x", Buffer.from("hi"));
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
    const r = await createMachine({ backend: b, cfg, state, session: SESSION }, { image: "alpine" });
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
    const r = await createMachine({ backend: b, cfg: testConfig(), state, session: SESSION }, { image: "alpine", name: "keep-me", start: false });
    expect(r.ephemeral).toBe(false);
    expect(r.ready).toBe(false);
    expect(state.read().machines).toEqual([]);
  });
});

describe("runOnce", () => {
  it("is create, start, exec, delete on the plain path", async () => {
    const b = new FakeBackend();
    b.execImpl = async (_n, req) => ({ exitCode: req.command[0] === "echo" ? 0 : 7, stdout: req.command[0] === "echo" ? `${req.command[1]}\n` : "hello\n", stderr: "" });
    const r = await runOnce({ backend: b, cfg: testConfig(), state: undefined, session: SESSION }, { image: "alpine", command: ["sh", "-c", "echo hello; exit 7"] });
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
    const r = await runOnce({ backend: b, cfg: testConfig(), state: undefined, session: SESSION }, { image: "alpine", command: ["sleep", "999"], timeoutSecs: 2 });
    expect(r.timedOut).toBe(true);
    expect(b.machines.size).toBe(0);
    expect(execs).toBe(2);

    const b2 = new FakeBackend();
    b2.execImpl = async () => {
      throw new Error("socket hang up");
    };
    await expect(runOnce({ backend: b2, cfg: testConfig({ readyTimeoutSecs: 0 }), state: undefined, session: SESSION }, { image: "alpine", command: "true" })).rejects.toThrow(/did not become ready/);
    expect(b2.machines.size).toBe(0);
    expect(b2.calls.at(-1)?.op).toBe("delete");
  });

  it("takes the local network default from config and blocks by default on cloud", async () => {
    const ready = async (_n: string, req: { command: string[] }) => ({ exitCode: 0, stdout: `${req.command[1] ?? ""}\n`, stderr: "" });
    const local = new FakeBackend("local");
    local.execImpl = ready;
    await runOnce({ backend: local, cfg: testConfig({ runOnceNetwork: "blocked" }), state: undefined, session: SESSION }, { image: "alpine", command: "true" });
    expect((local.calls[0]?.args as { network: unknown }).network).toEqual({ mode: "blocked" });

    // No config knob decides this one: an untrusted command on a billed
    // fleet gets no egress unless the caller names an allow-list.
    const cloud = new FakeBackend("cloud");
    cloud.execImpl = ready;
    await runOnce({ backend: cloud, cfg: testConfig(), state: undefined, session: SESSION }, { image: "alpine", command: "true" });
    expect((cloud.calls[0]?.args as { network: unknown }).network).toEqual({ mode: "blocked" });
  });

  it("sends every lifecycle backstop the API has so a killed server cannot leave a machine billing", async () => {
    const b = new FakeBackend("cloud");
    b.execImpl = async (_n, req) => ({ exitCode: 0, stdout: `${req.command[1] ?? ""}\n`, stderr: "" });

    await runOnce({ backend: b, cfg: testConfig({ ephemeralTtlSecs: 600, ephemeralAutoStopSecs: 60 }), state: undefined, session: SESSION }, { image: "alpine", command: "true" });
    // ttlSeconds alone caps the bill at an hour; the idle stop ends it at the
    // first quiet window, and ephemeral is what turns that stop into a delete
    // rather than a machine kept stopped with its disk still billing.
    expect(b.calls[0]?.args).toMatchObject({ ttlSeconds: 600, autoStopSeconds: 60, ephemeral: true });
  });

  it("sends the same backstops for an ephemeral create, and none for a named machine", async () => {
    const b = new FakeBackend("cloud");
    const m = { backend: b, cfg: testConfig({ ephemeralTtlSecs: 600, ephemeralAutoStopSecs: 60 }), state: undefined, session: SESSION };
    await createMachine(m, { image: "alpine", start: false });
    expect(b.calls[0]?.args).toMatchObject({ ttlSeconds: 600, autoStopSeconds: 60, ephemeral: true });
    b.calls.length = 0;
    // A machine the caller named is theirs to keep; nothing here deletes it.
    await createMachine(m, { name: "keeper", image: "alpine", start: false });
    const args = b.calls[0]?.args as Record<string, unknown>;
    for (const key of ["ttlSeconds", "autoStopSeconds", "ephemeral"]) expect(args, key).not.toHaveProperty(key);
  });
});

describe("cleanupEphemeral", () => {
  it("deletes this session's prefixed machines and a dead process's, never a live sibling session's", async () => {
    const b = new FakeBackend();
    const open = { image: "a", cpus: 1, memoryMb: 1, network: { mode: "open" as const } };
    for (const name of ["mcp-mine", "mcp-dead", "mcp-sibling", "keep"]) await b.createMachine({ name, ...open });
    const state = new StateFile(join(mkdtempSync(join(tmpdir(), "smol-mcp-st-")), "machines.json"));
    state.add("mcp-mine", SESSION);
    state.add("mcp-dead", "a-session-of-a-crashed-process", "mcp-dead", 999999999);
    // Another session in this same process. Under a pid-keyed record this one
    // was deleted here, and the session that created it was never told.
    state.add("mcp-sibling", "another-live-session");
    state.add("keep", SESSION);
    b.calls.length = 0;
    const r = await cleanupEphemeral({ backend: b, cfg: testConfig(), state, session: SESSION });
    expect(r.deleted.sort()).toEqual(["mcp-dead", "mcp-mine"]);
    expect(r.failed).toEqual([]);
    expect([...b.machines.keys()].sort()).toEqual(["keep", "mcp-sibling"]);
    expect(state.read().machines.map((m) => m.name).sort()).toEqual(["keep", "mcp-sibling"]);
    // A machine already gone is dropped from the state without an error.
    state.add("mcp-gone", SESSION);
    const r2 = await cleanupEphemeral({ backend: b, cfg: testConfig(), state, session: SESSION });
    expect(r2.failed).toEqual([]);
    expect(state.read().machines.map((m) => m.name).sort()).toEqual(["keep", "mcp-sibling"]);
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

describe("cancellation and the timeout ceiling", () => {
  it("stops polling for readiness the moment the caller cancels", async () => {
    // A client's notifications/cancelled used to release nothing: the guest
    // command ran to its own timeout and the poll kept going.
    const b = new FakeBackend();
    b.execImpl = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    const control = new AbortController();
    const m = { backend: b, cfg: testConfig({ readyTimeoutSecs: 60 }), state: undefined, session: SESSION };
    const started = createMachine(m, { image: "alpine" }, { signal: control.signal });
    await new Promise((r) => setTimeout(r, 50));
    control.abort();
    await expect(started).rejects.toThrow();
    const attempts = b.calls.filter((c) => c.op === "exec").length;
    await new Promise((r) => setTimeout(r, 1200));
    // And it really stopped: no further attempt after the abort.
    expect(b.calls.filter((c) => c.op === "exec").length).toBe(attempts);
  });

  it("refuses a timeout above the ceiling rather than holding a machine for it", async () => {
    const b = new FakeBackend();
    const m = { backend: b, cfg: testConfig({ maxExecTimeoutSecs: 300 }), state: undefined, session: SESSION };
    await expect(runCommand(m, "m", { command: ["true"], timeoutSecs: 3600 })).rejects.toMatchObject({ code: "TIMEOUT_TOO_LONG" });
    // Refused before the call, so no machine was held at all.
    expect(b.calls).toEqual([]);
    await expect(runCommand(m, "m", { command: ["true"], timeoutSecs: 300 })).resolves.toBeDefined();
  });
});

describe("startMachine", () => {
  it("starts a stopped machine and waits until a command runs in it", async () => {
    const b = new FakeBackend();
    const m = { backend: b, cfg: testConfig(), state: undefined, session: SESSION };
    b.machines.set("keep", { id: "keep", name: "keep", state: "stopped", cpus: 2, memoryMb: 2048, network: "open", createdAt: 1, image: "alpine", pid: null });
    b.execImpl = async (_name, req) => ({ exitCode: 0, stdout: `${req.command[1]}\n`, stderr: "" });
    const r = await startMachine(m, "keep", true);
    expect(r.machine.state).toBe("running");
    expect(r.ready).toBe(true);
    // Readiness is an exec, so the wait proves commands run rather than that
    // the control plane accepted a start.
    expect(b.calls.map((c) => c.op)).toEqual(["start", "exec"]);
  });

  it("returns without waiting when wait is false", async () => {
    const b = new FakeBackend();
    const m = { backend: b, cfg: testConfig(), state: undefined, session: SESSION };
    const r = await startMachine(m, "keep", false);
    expect(r.ready).toBe(false);
    expect(b.calls.map((c) => c.op)).toEqual(["start"]);
  });
});
