import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolAnnotations, toolInputs } from "../../src/tools.js";
import type { ToolName } from "../../src/tools.js";
import { toArgv, truncate, shapeResult } from "../../src/output.js";

const both = toolInputs("both");
const schema = <K extends ToolName>(name: K) => z.object(both[name]);
const names = Object.keys(both) as ToolName[];

describe("tool input schemas", () => {
  it("requires target on every tool when both fleets are reachable, with no default", () => {
    for (const name of names) {
      const s = z.object(both[name]);
      const sample: Record<string, unknown> = { name: "m", image: "alpine", command: ["true"], path: "/x", content: "", childName: "c" };
      // A machine on one fleet is invisible on the other and the two bill
      // differently, so a defaulted target sends work to the wrong one
      // silently.
      expect(() => s.parse(sample), name).toThrow();
      expect((s.parse({ ...sample, target: "cloud" }) as { target: string }).target, name).toBe("cloud");
    }
  });

  it("drops target from every schema in a single-target mode", () => {
    for (const mode of ["local", "cloud"] as const) {
      for (const name of names) {
        const inputs = toolInputs(mode)[name] as Record<string, unknown>;
        expect(inputs, `${mode} ${name}`).not.toHaveProperty("target");
        const sample: Record<string, unknown> = { name: "m", image: "alpine", command: ["true"], path: "/x", content: "", childName: "c", target: "cloud" };
        expect(z.object(toolInputs(mode)[name]).parse(sample), `${mode} ${name}`).not.toHaveProperty("target");
      }
    }
  });

  it("rejects an unknown target", () => {
    expect(() => schema("list-machines").parse({ target: "staging" })).toThrow();
  });

  it("run-command accepts argv or a shell string", () => {
    expect(schema("run-command").parse({ target: "local", name: "m", command: ["echo", "hi"] }).command).toEqual(["echo", "hi"]);
    expect(schema("run-command").parse({ target: "local", name: "m", command: "echo hi" }).command).toBe("echo hi");
    expect(() => schema("run-command").parse({ target: "local", name: "m", command: [] })).toThrow();
  });

  it("create-machine requires an image and rejects the CLI flag spelling (constraint d)", () => {
    expect(() => schema("create-machine").parse({ target: "local" })).toThrow();
    const parsed = schema("create-machine").parse({ target: "local", image: "alpine", memoryMb: 512 });
    expect(parsed.memoryMb).toBe(512);
    // `net` and `memory` are the CLI's names. They are not in the schema, and
    // zod strips them, so the request body can never carry them.
    const stripped = schema("create-machine").parse({ target: "local", image: "alpine", net: true, memory: 512 }) as Record<string, unknown>;
    expect(stripped).not.toHaveProperty("net");
    expect(stripped).not.toHaveProperty("memory");
  });

  it("an egress allow-list survives the schema, and a bare network mode is optional", () => {
    const parsed = schema("run-once").parse({ target: "local", image: "alpine", command: "true", allowCidrs: ["10.0.0.0/8"] });
    expect(parsed.allowCidrs).toEqual(["10.0.0.0/8"]);
    expect(parsed.network).toBeUndefined();
    expect(() => schema("run-once").parse({ target: "local", image: "alpine", command: "true", network: "off" })).toThrow();
  });

  it("read-file and write-file default to utf8", () => {
    expect(schema("read-file").parse({ target: "local", name: "m", path: "/a" }).encoding).toBe("utf8");
    expect(schema("write-file").parse({ target: "local", name: "m", path: "/a", content: "x" }).encoding).toBe("utf8");
  });
});

describe("what the descriptions promise about egress", () => {
  const described = (tool: ToolName, field: string): string => {
    const shape = both[tool] as Record<string, { description?: string }>;
    return shape[field]?.description ?? "";
  };

  it("names the mechanism the deny is actually sent as, on the two tools that take it", () => {
    // This string is what an agent reads before it decides whether a machine
    // is safe to put something in. It said the cloud deny was sent as an
    // empty allow-list and that it was enforced; the code sends an
    // unroutable range, and an empty list is refused outright.
    const expected =
      "Egress mode. Default blocked on both targets. Local: a blocked machine whose image still has to be pulled from a registry is refused by the API; pass open or an allow-list for that create. Cloud: blocked is sent as an allow-list of an unroutable range, and a cloud machine that publishes a port cannot also block egress.";
    expect(described("create-machine", "network")).toBe(expected);
    expect(described("run-once", "network")).toBe(expected);
  });

  it("says where a hostname allow-list goes on each target, and does not call it local only", () => {
    // The argument is accepted on both targets: the cloud client appends
    // hostnames to the same list it sends CIDRs in.
    const expected =
      "Egress allow-list of hostnames. Overrides network. Local: sent as allowedHosts. Cloud: sent inside the same cidrs list the published schema names, alongside allowCidrs.";
    expect(described("create-machine", "allowHosts")).toBe(expected);
    expect(described("run-once", "allowHosts")).toBe(expected);
  });

  it("promises enforcement of a cloud deny nowhere in any tool description", () => {
    // A description that promises the platform enforces something is a
    // promise this server cannot keep and cannot check.
    const all: string[] = [];
    for (const shape of Object.values(both)) {
      for (const field of Object.values(shape as Record<string, { description?: string }>)) {
        if (typeof field.description === "string") all.push(field.description);
      }
    }
    expect(all.length).toBeGreaterThan(10);
    for (const text of all) expect(text, text).not.toMatch(/enforc/i);
  });
});

describe("tool annotations", () => {
  it("annotates every tool, so a new one without hints fails here", () => {
    // A client decides what to confirm from these. A tool that carries none
    // is treated as the most dangerous shape by a careful client and as the
    // safest by a careless one, and neither is what we meant.
    expect(Object.keys(toolAnnotations).sort()).toEqual(names.slice().sort());
  });

  it("marks the four that only read, and nothing else", () => {
    const readOnly = names.filter((n) => toolAnnotations[n].readOnlyHint === true);
    expect(readOnly.sort()).toEqual(["get-machine", "list-machines", "machine-logs", "read-file"]);
  });

  it("marks the two that destroy what is already there", () => {
    // write-file overwrites; delete-machine is the obvious one. A stop is not
    // destructive: the machine starts again with everything it had.
    const destructive = names.filter((n) => toolAnnotations[n].destructiveHint === true);
    expect(destructive.sort()).toEqual(["delete-machine", "write-file"]);
  });

  it("marks the three that can be repeated safely", () => {
    const idempotent = names.filter((n) => toolAnnotations[n].idempotentHint === true);
    expect(idempotent.sort()).toEqual(["pull-image", "start-machine", "stop-machine"]);
    for (const n of idempotent) expect(toolAnnotations[n].destructiveHint, n).toBe(false);
  });

  it("marks the three that reach a registry, and no others", () => {
    const openWorld = names.filter((n) => toolAnnotations[n].openWorldHint === true);
    expect(openWorld.sort()).toEqual(["create-machine", "pull-image", "run-once"]);
    for (const n of names) expect(typeof toolAnnotations[n].openWorldHint, n).toBe("boolean");
  });
});

describe("output shaping", () => {
  it("wraps a string command in sh -c", () => {
    expect(toArgv("echo hi")).toEqual(["sh", "-c", "echo hi"]);
    expect(toArgv(["ls", "-l"])).toEqual(["ls", "-l"]);
  });

  it("keeps the head and the tail inside the byte budget and says what fell out", () => {
    // The tail matters: a failing command's last line is the message, and a
    // head-only cut is exactly the part a caller does not need.
    const r = truncate(`START${"x".repeat(90)}END`, 12);
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(98);
    // 12 bytes of budget: 8 of head, 4 of tail, and the count of what fell
    // between them.
    expect(r.text).toBe("STARTxxx\n[... 86 bytes dropped ...]\nxEND");
    expect(truncate("small", 10)).toEqual({ text: "small", truncated: false, bytes: 5 });
  });

  it("reports a cut the API made, not only the one this server made", () => {
    // The cloud exec response carries these two flags and they used to be
    // parsed and dropped, so a result that lost a megabyte server side
    // reported truncated: false and read as complete.
    const r = shapeResult({ exitCode: 0, stdout: "short", stderr: "", stdoutTruncated: true }, 1024);
    expect(r.truncated).toBe(true);
    expect(shapeResult({ exitCode: 0, stdout: "short", stderr: "", stderrTruncated: true }, 1024).truncated).toBe(true);
    expect(shapeResult({ exitCode: 0, stdout: "short", stderr: "" }, 1024).truncated).toBe(false);
  });

  it("reads the exit code from the body and flags the server-side timeout", () => {
    const r = shapeResult({ exitCode: 3, stdout: "out\n", stderr: "err\n" }, 1024);
    expect(r).toEqual({ stdout: "out\n", stderr: "err\n", exitCode: 3, truncated: false, timedOut: false, overflow: [] });
    const t = shapeResult({ exitCode: 124, stdout: "before\n", stderr: "\ncommand timed out after 2000ms" }, 1024);
    expect(t.timedOut).toBe(true);
    expect(t.exitCode).toBe(124);
  });
});
