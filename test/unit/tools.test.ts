import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolInputs } from "../../src/tools.js";
import { toArgv, truncate, shapeResult } from "../../src/output.js";

const schema = <K extends keyof typeof toolInputs>(name: K) => z.object(toolInputs[name]);

describe("tool input schemas", () => {
  it("default target is local on every tool", () => {
    for (const name of Object.keys(toolInputs) as (keyof typeof toolInputs)[]) {
      const s = z.object(toolInputs[name]);
      const sample: Record<string, unknown> = { name: "m", image: "alpine", command: ["true"], path: "/x", content: "" };
      const parsed = s.parse(sample) as { target: string };
      expect(parsed.target, name).toBe("local");
    }
  });

  it("rejects an unknown target", () => {
    expect(() => schema("list-machines").parse({ target: "staging" })).toThrow();
  });

  it("run-command accepts argv or a shell string", () => {
    expect(schema("run-command").parse({ name: "m", command: ["echo", "hi"] }).command).toEqual(["echo", "hi"]);
    expect(schema("run-command").parse({ name: "m", command: "echo hi" }).command).toBe("echo hi");
    expect(() => schema("run-command").parse({ name: "m", command: [] })).toThrow();
  });

  it("create-machine requires an image and rejects the CLI flag spelling (constraint d)", () => {
    expect(() => schema("create-machine").parse({})).toThrow();
    const parsed = schema("create-machine").parse({ image: "alpine", memoryMb: 512 });
    expect(parsed.memoryMb).toBe(512);
    // `net` and `memory` are the CLI's names. They are not in the schema, and
    // zod strips them, so the request body can never carry them.
    const stripped = schema("create-machine").parse({ image: "alpine", net: true, memory: 512 }) as Record<string, unknown>;
    expect(stripped).not.toHaveProperty("net");
    expect(stripped).not.toHaveProperty("memory");
  });

  it("an egress allow-list survives the schema, and a bare network mode is optional", () => {
    const parsed = schema("run-once").parse({ image: "alpine", command: "true", allowCidrs: ["10.0.0.0/8"] });
    expect(parsed.allowCidrs).toEqual(["10.0.0.0/8"]);
    expect(parsed.network).toBeUndefined();
    expect(() => schema("run-once").parse({ image: "alpine", command: "true", network: "off" })).toThrow();
  });

  it("read-file and write-file default to utf8", () => {
    expect(schema("read-file").parse({ name: "m", path: "/a" }).encoding).toBe("utf8");
    expect(schema("write-file").parse({ name: "m", path: "/a", content: "x" }).encoding).toBe("utf8");
  });
});

describe("output shaping", () => {
  it("wraps a string command in sh -c", () => {
    expect(toArgv("echo hi")).toEqual(["sh", "-c", "echo hi"]);
    expect(toArgv(["ls", "-l"])).toEqual(["ls", "-l"]);
  });

  it("truncates to the byte budget and says how much was dropped", () => {
    const big = "x".repeat(100);
    const r = truncate(big, 10);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("xxxxxxxxxx\n[truncated: 90 more bytes]")).toBe(true);
    expect(truncate("small", 10)).toEqual({ text: "small", truncated: false });
  });

  it("reads the exit code from the body and flags the server-side timeout", () => {
    const r = shapeResult({ exitCode: 3, stdout: "out\n", stderr: "err\n" }, 1024);
    expect(r).toEqual({ stdout: "out\n", stderr: "err\n", exitCode: 3, truncated: false, timedOut: false });
    const t = shapeResult({ exitCode: 124, stdout: "before\n", stderr: "\ncommand timed out after 2000ms" }, 1024);
    expect(t.timedOut).toBe(true);
    expect(t.exitCode).toBe(124);
  });
});
