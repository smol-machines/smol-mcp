import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, loadConfig } from "../../src/config.js";

describe("config", () => {
  it("ships the tethered defaults", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.memoryMb).toBe(2048);
    expect(cfg.cpus).toBe(2);
    expect(cfg.execTimeoutSecs).toBe(120);
    expect(cfg.maxOutputBytes).toBe(64 * 1024);
    expect(cfg.machinePrefix).toBe("mcp-");
    // The design default is off; the local API refuses a create with no
    // egress path when the image still has to be pulled, so the shipped
    // local default is open. Cloud does not read this (README).
    expect(cfg.runOnceNetwork).toBe("open");
    expect(cfg.ephemeralTtlSecs).toBe(3600);
  });

  it("env overrides file overrides defaults, with typed coercion", () => {
    const dir = mkdtempSync(join(tmpdir(), "smol-mcp-cfg-"));
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ memoryMb: 512, cpus: 1, runOnceNetwork: "open" }));
    const cfg = loadConfig({ SMOL_MCP_MEMORY_MB: "1024", SMOL_MCP_RUN_ONCE_NETWORK: "blocked", HOME: dir }, file);
    expect(cfg.memoryMb).toBe(1024);
    expect(cfg.cpus).toBe(1);
    expect(cfg.runOnceNetwork).toBe("blocked");
    expect(cfg.runtimeDir).not.toBe("");
  });

  it("rejects an unknown key in the config file instead of ignoring it", () => {
    const dir = mkdtempSync(join(tmpdir(), "smol-mcp-cfg-"));
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ memory: 512 }));
    expect(() => loadConfig({}, file)).toThrow(/unrecognized/i);
  });

  it("uses XDG_RUNTIME_DIR for the runtime dir when set", () => {
    const cfg = loadConfig({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/nonexistent/config.json");
    expect(cfg.runtimeDir).toBe("/run/user/1000/smol-mcp");
  });
});
