// The cloud target against the real smol cloud API. This suite spends money,
// so it is gated twice: on SMOL_MCP_IT plus a token, and on a spend ceiling
// read from the account before anything is created. Every machine it makes is
// deleted in the same test that made it, and the sweep at the end proves it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudClient } from "../../src/cloud/client.js";
import * as ops from "../../src/machines.js";
import type { Machines } from "../../src/machines.js";
import { CLOUD_IT, IT_PREFIX, itConfig, unique } from "./harness.js";

const SESSION = "cloud-integration";

// USD 1.00 of period spend. Reaching it stops the suite rather than slowing
// it down: an overspend caused by a test is the kind of thing nobody notices
// until the bill arrives.
const CEILING_MICROS = 1_000_000;
// The smallest shape the plan allows. Cost is dominated by a per-hour base
// rate, so the size matters less than the seconds, but there is no reason to
// ask for more than an echo needs.
const CLOUD_IMAGE = process.env.SMOL_MCP_IT_CLOUD_IMAGE ?? "alpine:3.20";
const SMALL = { cpus: 1, memoryMb: 256 };

const suite = CLOUD_IT ? describe : describe.skip;

let client: CloudClient;
let m: Machines;
let baselineMicros = 0;

async function spend(): Promise<number> {
  return (await client.account()).periodCost.totalMicros;
}

// Called after every test. Reading it as an assertion means the run fails on
// the test that crossed the line, not three tests later.
async function assertUnderCeiling(): Promise<number> {
  const now = await spend();
  expect(now, `period spend ${now} micros is over the ceiling of ${CEILING_MICROS}`).toBeLessThan(CEILING_MICROS);
  return now;
}

beforeAll(async () => {
  if (!CLOUD_IT) return;
  const cfg = itConfig({ readyTimeoutSecs: 180 });
  client = new CloudClient(cfg.cloudUrl, cfg.cloudToken);
  const account = await client.account();
  expect(account.status).toBe("active");
  baselineMicros = account.periodCost.totalMicros;
  console.log(`cloud baseline: periodCost.totalMicros=${baselineMicros}, machineCount=${account.periodUsage.machineCount}`);
  expect(baselineMicros, "period spend is already over the ceiling; not creating anything").toBeLessThan(CEILING_MICROS);
  m = { backend: client, cfg, state: undefined, session: SESSION };
});

afterAll(async () => {
  if (!CLOUD_IT) return;
  const leaks = (await client.listMachines()).filter((x) => x.name.startsWith(IT_PREFIX));
  for (const leak of leaks) await client.deleteMachine(leak.id).catch(() => undefined);
  const after = await spend();
  console.log(`cloud settled: periodCost.totalMicros=${after}, delta=${after - baselineMicros} micros, leaked=${leaks.length}`);
  expect(leaks.map((x) => x.name)).toEqual([]);
});

suite("cloud lifecycle", () => {
  it("creates, runs a failing command, round-trips a file, stops and deletes with the settled bill", async () => {
    const name = unique("life");
    const created = await ops.createMachine(m, { name, image: CLOUD_IMAGE, ...SMALL, network: "blocked" });
    expect(created.machine.id.startsWith("mach-")).toBe(true);
    expect(created.machine.name).toBe(name);
    // blocked is sent as an allow-list of an unroutable range, because an
    // empty allow-list is a 400.
    expect(created.machine.network).toBe("allowCidrs");
    // The bare reference is resolved by the service, not echoed back.
    expect(created.machine.image).toContain("alpine");

    // The deny is asserted from inside the guest on the byte count, not on
    // wget's exit code: a wrapper that swallows the exit code reports nothing,
    // and an empty body is the value that cannot be misread.
    const egress = await ops.runCommand(m, name, { command: ["sh", "-c", "wget -T 8 -q -O- http://example.com 2>/dev/null | wc -c"], timeoutSecs: 30 });
    expect(egress.stdout.trim()).toBe("0");

    // Constraint (b) on this target too: HTTP 200 for a command that failed.
    const failed = await ops.runCommand(m, name, { command: "echo to-out; echo to-err >&2; exit 42" });
    expect(failed.exitCode).toBe(42);
    expect(failed.stdout).toBe("to-out\n");
    expect(failed.stderr).toBe("to-err\n");

    const payload = Buffer.from(`cloud-payload-${name}\n`);
    expect(await ops.writeFile(m, name, "/root/it.txt", payload)).toEqual({ path: "/root/it.txt", size: payload.length });
    expect((await ops.runCommand(m, name, { command: ["cat", "/root/it.txt"] })).stdout).toBe(payload.toString());
    expect((await m.backend.readFile(name, "/root/it.txt")).toString()).toBe(payload.toString());

    expect((await m.backend.stopMachine(name)).state).not.toBe("running");
    const gone = await m.backend.deleteMachine(name);
    expect(gone.usageMicros).toBeTypeOf("number");
    console.log(`cloud lifecycle settled bill: ${gone.usageMicros} micros`);
    await expect(m.backend.getMachine(name)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await assertUnderCeiling();
  });

  it("refuses the two local-only tools rather than pretending", async () => {
    await expect(m.backend.logs("anything", 10)).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
    await expect(m.backend.pullImage("anything", "alpine")).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });
});

suite("cloud run-once", () => {
  it("runs one command with no egress and no machine left behind", async () => {
    const r = await ops.runOnce(m, { image: CLOUD_IMAGE, command: "echo hello", ...SMALL });
    expect(r.stdout).toBe("hello\n");
    expect(r.exitCode).toBe(0);
    expect((await m.backend.listMachines()).map((x) => x.name)).not.toContain(r.machine);
    await assertUnderCeiling();
  });

  it("deletes the machine when the command hangs past its timeout", async () => {
    const r = await ops.runOnce(m, { image: CLOUD_IMAGE, command: ["sleep", "600"], timeoutSecs: 10, ...SMALL });
    expect(r.exitCode).not.toBe(0);
    expect((await m.backend.listMachines()).map((x) => x.name)).not.toContain(r.machine);
    await assertUnderCeiling();
  });
});
