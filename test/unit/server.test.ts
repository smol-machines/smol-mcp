// Session cleanup, driven through createServer with both backends faked. No
// smolvm, no network, no key.
import { describe, expect, it } from "vitest";
import { createServer } from "../../src/server.js";
import * as ops from "../../src/machines.js";
import { FakeBackend, testConfig } from "./fake-backend.js";

describe("shutdown", () => {
  it("deletes the cloud machines this session created, with no local call ever made", async () => {
    // The cloud target used to keep no record at all, so an ephemeral machine
    // created here survived the client that asked for it and billed to its
    // TTL. The HTTP transport made it worse: its shutdown returned an empty
    // result the moment no local call had run, which is every cloud session.
    const cloudBackend = new FakeBackend("cloud");
    const app = await createServer({ cfg: testConfig({ smolvm: "smolvm-that-is-not-installed" }), log: () => {}, cloudBackend });
    await ops.createMachine(app.cloud, { image: "alpine", start: false });
    const created = cloudBackend.calls.find((c) => c.op === "create")?.name;
    expect(created).toMatch(/^mcp-/);

    const r = await app.shutdown();
    expect(r.deleted).toEqual([created]);
    expect(r.failed).toEqual([]);
    expect(cloudBackend.machines.size).toBe(0);
  });

  it("leaves a machine the caller named alone", async () => {
    const cloudBackend = new FakeBackend("cloud");
    const app = await createServer({ cfg: testConfig(), log: () => {}, cloudBackend });
    await ops.createMachine(app.cloud, { name: "keeper", image: "alpine", start: false });
    expect(await app.shutdown()).toEqual({ deleted: [], failed: [] });
    expect([...cloudBackend.machines.keys()]).toEqual(["keeper"]);
  });

  it("deletes a cloud machine by the id the create returned", async () => {
    const cloudBackend = new FakeBackend("cloud");
    // The cloud API addresses a machine by an id that is not its name, and
    // resolving a name back to one costs a list call per machine at cleanup.
    cloudBackend.idFor = (name) => `mach-${name}`;
    const app = await createServer({ cfg: testConfig(), log: () => {}, cloudBackend });
    await ops.createMachine(app.cloud, { image: "alpine", start: false });
    await app.shutdown();
    expect(cloudBackend.calls.filter((c) => c.op === "delete").map((c) => c.name)).toEqual([expect.stringMatching(/^mach-mcp-/)]);
  });
});
