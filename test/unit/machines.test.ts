import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBackend, testConfig } from "./fake-backend.js";

// Every record in this file belongs to one session; the cross-session cases
// name their own.
const SESSION = "session-under-test";
import { StateFile } from "../../src/local/state.js";
import { KEEPALIVE_CMD, cleanupEphemeral, createMachine, logs, networkPolicy, readFile, runCommand, runCommandOnMachine, runOnce, startMachine, waitReady, writeFile } from "../../src/machines.js";

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

describe("reporting a machine the cloud target starts for us", () => {
  const stopped = (name: string) => ({ id: name, name, state: "stopped", cpus: 1, memoryMb: 256, network: "open", createdAt: 1, image: "alpine", pid: null });

  function fleet(target: "local" | "cloud", state: string) {
    const b = new FakeBackend(target);
    b.machines.set("m", { ...stopped("m"), state });
    b.execImpl = async (_name, req) => ({ exitCode: 0, stdout: req.command.includes("READY") ? `${req.command[1]}\n` : "out", stderr: "" });
    return { backend: b, cfg: testConfig(), state: undefined, session: SESSION };
  }

  it("says a stopped cloud machine was started by the command, the read and the write", async () => {
    // Cloud exec auto-starts a stopped machine and nothing stops it again, so
    // a caller who stopped a machine to stop paying is paying again after a
    // read it thought was passive.
    const m = fleet("cloud", "stopped");
    m.backend.execImpl = async (_n, req) => ({ exitCode: 0, stdout: `${req.command[1] ?? ""}\n`, stderr: "" });
    m.backend.files.set("m:/f", Buffer.from("hi"));
    expect((await runCommandOnMachine(m, "m", { command: ["true"] })).startedMachine).toBe(true);
    expect((await readFile(m, "m", "/f")).startedMachine).toBe(true);
    expect((await writeFile(m, "m", "/g", Buffer.from("x"))).startedMachine).toBe(true);
  });

  it("says nothing was started when the cloud machine is already running", async () => {
    const m = fleet("cloud", "started");
    expect((await runCommandOnMachine(m, "m", { command: ["true"] })).startedMachine).toBe(false);
  });

  it("never claims a start on local, and pays no extra call to find out", async () => {
    const m = fleet("local", "stopped");
    const r = await runCommandOnMachine(m, "m", { command: ["true"] });
    expect(r.startedMachine).toBe(false);
    expect(m.backend.calls.map((c) => c.op)).toEqual(["exec"]);
  });
});

describe("readFile ranges", () => {
  const fleet = (over = {}) => {
    const b = new FakeBackend();
    b.files.set("m:/big", Buffer.from("0123456789"));
    return { backend: b, cfg: testConfig({ maxOutputBytes: 4, ...over }), state: undefined, session: SESSION };
  };

  it("returns the head within the output budget and says the file is longer", async () => {
    // Without a range the whole file went into one tool result, so a file
    // past the model's budget arrived cut with nothing saying where to
    // resume.
    const r = await readFile(fleet(), "m", "/big");
    expect(r.content.toString()).toBe("0123");
    expect(r).toMatchObject({ size: 10, offset: 0, eof: false });
  });

  it("pages from an offset and reports the end of the file", async () => {
    const r = await readFile(fleet(), "m", "/big", { offset: 4, length: 6 });
    expect(r.content.toString()).toBe("456789");
    expect(r).toMatchObject({ size: 10, offset: 4, eof: true });
  });

  it("clamps an offset past the end to an empty read at the end", async () => {
    const r = await readFile(fleet(), "m", "/big", { offset: 99 });
    expect(r.content).toHaveLength(0);
    expect(r).toMatchObject({ size: 10, offset: 10, eof: true });
  });

  it("honours a length larger than the budget when the caller asks for one", async () => {
    const r = await readFile(fleet(), "m", "/big", { length: 10 });
    expect(r.content.toString()).toBe("0123456789");
    expect(r.eof).toBe(true);
  });
});

describe("output too big for one result", () => {
  const big = "L".repeat(5000);

  function fleet() {
    const b = new FakeBackend();
    b.execImpl = async () => ({ exitCode: 1, stdout: big, stderr: "the last line is the message\n" });
    return { backend: b, cfg: testConfig({ maxOutputBytes: 100 }), state: undefined, session: SESSION };
  }

  it("writes the whole stream into the machine and names the path, the stream and the byte count", async () => {
    const m = fleet();
    const r = await runCommand(m, "m", { command: ["noisy"] });
    expect(r.truncated).toBe(true);
    expect(r.overflow).toEqual([{ stream: "stdout", path: expect.stringMatching(/^\/tmp\/smol-mcp-[0-9a-f]{8}\.stdout$/), bytes: 5000 }]);
    // The head and the tail are both in the result, and the path is the way
    // to the 4900 bytes between them.
    expect(r.stdout.startsWith("LLL")).toBe(true);
    expect(r.stdout).toContain("bytes dropped");
    expect(r.stdout).toContain(String(r.overflow[0]?.path));
    // stderr fitted, so nothing was written for it.
    expect(m.backend.files.get(`m:${String(r.overflow[0]?.path)}`)?.length).toBe(5000);
    expect(m.backend.calls.filter((c) => c.op === "write")).toHaveLength(1);
  });

  it("still answers the call when the spill cannot be written", async () => {
    const m = fleet();
    m.backend.writeFile = async () => {
      throw new Error("read-only guest");
    };
    const r = await runCommand(m, "m", { command: ["noisy"] });
    expect(r.truncated).toBe(true);
    expect(r.overflow).toEqual([]);
    expect(r.exitCode).toBe(1);
  });

  it("does not spill for run-once, whose machine is deleted before anyone could read it", async () => {
    const b = new FakeBackend();
    b.execImpl = async (_n, req) => (req.command[0] === "echo" ? { exitCode: 0, stdout: `${req.command[1] ?? ""}\n`, stderr: "" } : { exitCode: 0, stdout: big, stderr: "" });
    const r = await runOnce({ backend: b, cfg: testConfig({ maxOutputBytes: 100 }), state: undefined, session: SESSION }, { image: "alpine", command: ["noisy"] });
    expect(r.truncated).toBe(true);
    expect(r.overflow).toEqual([]);
    expect(b.calls.some((c) => c.op === "write")).toBe(false);
  });
});

describe("a page of a machine's log", () => {
  it("stays inside the output budget and keeps the newest lines", async () => {
    // machine-logs used to return whatever came back, and on the HTTP
    // transport that is one JSON reply carrying the whole console.
    const b = new FakeBackend();
    b.logLines = ["a".repeat(30), "b".repeat(30), "c".repeat(30)];
    const page = await logs({ backend: b, cfg: testConfig({ maxOutputBytes: 70 }), state: undefined, session: SESSION }, "m", {});
    expect(page.lines).toEqual(["b".repeat(30), "c".repeat(30)]);
    expect(page.truncated).toBe(true);
  });

  it("takes the tail from config and passes a cursor straight through", async () => {
    const b = new FakeBackend();
    b.logLines = ["1", "2", "3", "4"];
    const m = { backend: b, cfg: testConfig({ logsTail: 2 }), state: undefined, session: SESSION };
    expect((await logs(m, "m", {})).lines).toEqual(["3", "4"]);
    expect(b.calls.at(-1)?.args).toEqual({ tail: 2, ctx: {} });
    const page = await logs(m, "m", { cursor: "2" });
    expect(page.lines).toEqual(["3", "4"]);
    expect(page.cursor).toBe("4");
    // Nothing new since: an empty page and the same cursor, which is what a
    // follower needs to tell "quiet" from "start again".
    expect((await logs(m, "m", { cursor: page.cursor })).lines).toEqual([]);
  });
});
