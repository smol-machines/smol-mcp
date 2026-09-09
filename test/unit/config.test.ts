import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, allowedHosts, allowedOrigins, loadConfig, resolveTargets } from "../../src/config.js";

describe("config", () => {
  it("ships the tethered defaults", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.memoryMb).toBe(2048);
    expect(cfg.cpus).toBe(2);
    expect(cfg.execTimeoutSecs).toBe(120);
    expect(cfg.maxOutputBytes).toBe(64 * 1024);
    expect(cfg.machinePrefix).toBe("mcp-");
    // Off on both targets. The local API refuses a blocked create whose
    // image still has to be pulled, and the tool error says how to opt in for
    // that one create rather than the default opening egress for everything.
    expect(cfg.networkDefault).toBe("blocked");
    expect(cfg.runOnceNetwork).toBe("blocked");
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

  it("auto resolves to both when a cloud token is configured and to local otherwise", () => {
    expect(resolveTargets(ConfigSchema.parse({}))).toBe("local");
    expect(resolveTargets(ConfigSchema.parse({ cloudToken: "k" }))).toBe("both");
    // An explicit mode wins over the token: a host with a token that only
    // wants the local fleet must be able to say so and lose the argument.
    expect(resolveTargets(ConfigSchema.parse({ cloudToken: "k", targets: "local" }))).toBe("local");
    expect(resolveTargets(ConfigSchema.parse({ targets: "cloud" }))).toBe("cloud");
    expect(resolveTargets(loadConfig({ SMOL_MCP_TARGETS: "both" }, "/nonexistent/config.json"))).toBe("both");
  });

  it("defaults the Host allow-list to the loopback names of the bound port, and to nothing off loopback", () => {
    const cfg = ConfigSchema.parse({});
    expect(allowedHosts(cfg, 8080)).toEqual(["127.0.0.1:8080", "localhost:8080", "[::1]:8080"]);
    // A published listener answers to a name this process cannot know, so
    // the check is off until the operator names it, and the startup log says
    // so rather than pretending the list is doing something.
    expect(allowedHosts(ConfigSchema.parse({ httpHost: "0.0.0.0" }), 8080)).toEqual([]);
    expect(allowedHosts(ConfigSchema.parse({ httpHost: "0.0.0.0", httpAllowedHosts: "mcp.example, mcp.example:443" }), 8080)).toEqual(["mcp.example", "mcp.example:443"]);
    expect(allowedOrigins(ConfigSchema.parse({ httpAllowedOrigins: " https://a.example ,, https://b.example " }))).toEqual(["https://a.example", "https://b.example"]);
  });

  it("uses XDG_RUNTIME_DIR for the runtime dir when set", () => {
    const cfg = loadConfig({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/nonexistent/config.json");
    expect(cfg.runtimeDir).toBe("/run/user/1000/smol-mcp");
  });
});
