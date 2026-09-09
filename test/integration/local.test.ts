// The local target against a real `smolvm serve` and real microVMs. Nothing
// here is mocked: every assertion is on a value a booted guest produced.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { BackendError } from "../../src/backend.js";
import { checkParity } from "../../src/parity.js";
import { createServer } from "../../src/server.js";
import type { SmolMcp } from "../../src/server.js";
import * as ops from "../../src/machines.js";
import type { Machines } from "../../src/machines.js";
import { IMAGE, LOCAL_IT, itConfig, unique } from "./harness.js";

const suite = LOCAL_IT ? describe : describe.skip;

let app: SmolMcp;
let m: Machines;

beforeAll(async () => {
  if (!LOCAL_IT) return;
  app = await createServer({ cfg: itConfig(), log: () => {} });
  m = await app.local();
});

afterAll(async () => {
  if (!LOCAL_IT) return;
  await app.shutdown();
});

suite("local parity", () => {
  // Constraint (c): the spec's info.version is hardcoded at 0.5.2 on a
  // v1.14.3 binary, so parity is stated by the paths this server calls.
  it("calls only paths the running binary serves, and does not trust info.version", () => {
    const cfg = itConfig();
    const spec: unknown = JSON.parse(execFileSync(cfg.smolvm, ["serve", "openapi"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
    const report = checkParity(spec);
    expect(report.missing).toEqual([]);
    expect(report.present.length).toBeGreaterThan(10);
    // The number that must never be used as the parity claim.
    expect(report.specVersion).toBe("0.5.2");
  });

  it("reports the real version from /health, which is the binary's own", async () => {
    const handle = await app.serve();
    expect(handle.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(handle.version).not.toBe("0.5.2");
  });
});

suite("local lifecycle", () => {
  it("creates, runs a failing command, round-trips a file, stops and deletes", async () => {
    const name = unique("life");
    // Egress is off by default and this image is pulled inside the guest, so
    // the create that pulls it has to ask, which is the trap the README names.
    const created = await ops.createMachine(m, { name, image: IMAGE, network: "open" });
    expect(created.machine.state).toBe("running");
    expect(created.ready).toBe(true);
    expect(created.machine.network).toBe("open");

    // Constraint (b): a guest command that failed is HTTP 200. The exit code
    // is read from the body, so a non-zero exit is a result and not an error.
    const failed = await ops.runCommand(m, name, { command: "echo to-out; echo to-err >&2; exit 42" });
    expect(failed.exitCode).toBe(42);
    expect(failed.stdout).toBe("to-out\n");
    expect(failed.stderr).toBe("to-err\n");
    expect(failed.truncated).toBe(false);

    // Constraint (a): the upload goes through the readiness gate, so the file
    // lands in the workload container's namespace rather than under the mount
    // that later hides it. The proof is the guest reading its own bytes back.
    const payload = Buffer.from(`payload-${name}\n`);
    const up = await ops.writeFile(m, name, "/root/it.txt", payload);
    expect(up.size).toBe(payload.length);
    const cat = await ops.runCommand(m, name, { command: ["cat", "/root/it.txt"] });
    expect(cat.stdout).toBe(payload.toString());
    expect((await m.backend.readFile(name, "/root/it.txt")).toString()).toBe(payload.toString());

    const stopped = await m.backend.stopMachine(name);
    expect(stopped.state).not.toBe("running");
    expect(await ops.deleteMachine(m, name)).toBe(name);
    await expect(m.backend.getMachine(name)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("truncates a stream past the budget and says how much it dropped", async () => {
    const name = unique("trunc");
    await ops.createMachine(m, { name, image: IMAGE, network: "open" });
    try {
      const r = await ops.runCommand({ ...m, cfg: { ...m.cfg, maxOutputBytes: 256 } }, name, {
        command: ["sh", "-c", "yes abcdefgh | head -c 4096"],
      });
      expect(r.truncated).toBe(true);
      // Head and tail with the dropped count between them, and the whole
      // stream written back into the machine at a path the result names.
      expect(r.stdout).toContain("bytes dropped");
      expect(r.stdout.startsWith("abcdefgh")).toBe(true);
      expect(r.stdout.trimEnd().endsWith("]")).toBe(true);
      expect(r.overflow).toEqual([{ stream: "stdout", path: expect.stringMatching(/^\/tmp\/smol-mcp-[0-9a-f]{8}\.stdout$/), bytes: 4096 }]);
      expect(r.exitCode).toBe(0);
    } finally {
      await ops.deleteMachine(m, name);
    }
  });

  it("refuses a network-off create whose image still has to be pulled, and says why", async () => {
    // The guard is why the blocked default has to be opt-out per create, so
    // assert it: a release that drops it would silently start granting egress.
    const err = (await m.backend
      .createMachine({ name: unique("nonet"), image: IMAGE, cpus: 1, memoryMb: 512, network: { mode: "blocked" } })
      .catch((e: unknown) => e)) as BackendError;
    expect(err).toBeInstanceOf(BackendError);
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toContain("no network, so the pull can never succeed");
  });

  it("adds the line naming the way out when the tool hits that refusal", async () => {
    // Through the tool rather than the client, so the caller sees both the
    // API's reason and the argument that grants the exception.
    const err = (await ops.createMachine(m, { name: unique("nonet2"), image: IMAGE, cpus: 1, memoryMb: 512 }).catch((e: unknown) => e)) as BackendError;
    expect(err.message).toContain("no network, so the pull can never succeed");
    expect(err.message).toContain('Pass network: "open" for this create');
  });
});

suite("local run-once", () => {
  it("creates, runs and deletes on the plain path, with no machine left behind", async () => {
    const before = await m.backend.listMachines();
    const r = await ops.runOnce(m, { image: IMAGE, command: "echo hello", network: "open" });
    expect(r.stdout).toBe("hello\n");
    expect(r.exitCode).toBe(0);
    expect(r.machine.startsWith("mcp-once-")).toBe(true);
    const after = await m.backend.listMachines();
    expect(after.map((x) => x.name)).not.toContain(r.machine);
    expect(after).toHaveLength(before.length);
  });

  it("deletes the machine when the command hangs past its timeout", async () => {
    const r = await ops.runOnce(m, { image: IMAGE, command: ["sleep", "600"], timeoutSecs: 5, network: "open" });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    const after = await m.backend.listMachines();
    expect(after.map((x) => x.name)).not.toContain(r.machine);
    // And the record no longer claims it, so the EOF sweep has nothing to
    // retry and nothing to report as a failure.
    expect((m.state?.owned(m.session) ?? []).map((x) => x.name)).not.toContain(r.machine);
  });
});
