// The HTTP transport, driven by the official MCP client over a real socket
// against a fake backend. No smolvm, no network, no key.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { applyArgs, startHttpTransport } from "../../src/http-transport.js";
import type { HttpTransportHandle } from "../../src/http-transport.js";
import { FakeBackend, testConfig } from "./fake-backend.js";

const TOKEN = "test-token-9f3a";

let running: HttpTransportHandle | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(over: Partial<Parameters<typeof testConfig>[0]> = {}) {
  const backend = new FakeBackend("local");
  running = await startHttpTransport({
    // Port 0 asks the OS for a free one; the handle reports what it got.
    cfg: testConfig({ authToken: TOKEN, httpPort: 0, runtimeDir: mkdtempSync(join(tmpdir(), "smol-mcp-http-")), ...over }),
    log: () => {},
    localBackend: backend,
  });
  return { backend, url: `http://127.0.0.1:${running.port}/mcp` };
}

async function connect(url: string, token = TOKEN) {
  const client = new Client({ name: "smol-mcp-http-test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  // Same exactOptionalPropertyTypes mismatch as the server side: the SDK's
  // class widens sessionId to `string | undefined`, the interface does not.
  await client.connect(transport as never);
  return { client, transport };
}

describe("http transport", () => {
  it("refuses to start without a token", async () => {
    // These tools create and run VMs. A listener without a token is a shell.
    await expect(startHttpTransport({ cfg: testConfig({ httpPort: 0 }), log: () => {} })).rejects.toThrow(/SMOL_MCP_AUTH_TOKEN/);
  });

  it("answers 401 with no token, a wrong token, and an empty bearer", async () => {
    const { url } = await start();
    const body = JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    for (const auth of [undefined, "Bearer wrong", "Bearer "]) {
      const res = await fetch(url, { method: "POST", headers: auth ? { ...headers, authorization: auth } : headers, body });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      const failed = (await res.json()) as { error: { message: string } };
      expect(failed.error.message).toMatch(/unauthorized/);
    }
  });

  it("takes its own token from x-smol-mcp-token when authorization carries something else", async () => {
    const { url } = await start();
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer some-other-credential", "x-smol-mcp-token": TOKEN },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("serves the whole tool vocabulary and runs a call against the backend", async () => {
    const { backend, url } = await start();
    backend.machines.set("mcp-a", { id: "mcp-a", name: "mcp-a", state: "running", cpus: 2, memoryMb: 2048, network: "open", createdAt: 1, image: "alpine", pid: 1 });
    const { client, transport } = await connect(url);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("list-machines");
    expect(names).toHaveLength(11);
    const res = await client.callTool({ name: "list-machines", arguments: { target: "local" } });
    expect(res.structuredContent).toEqual({ machines: [expect.objectContaining({ name: "mcp-a" })] });
    await transport.close();
  });

  it("deletes the session's ephemeral machines when the session is terminated", async () => {
    const { backend, url } = await start();
    const { client, transport } = await connect(url);
    await client.callTool({ name: "create-machine", arguments: { target: "local", image: "alpine" } });
    const created = backend.calls.find((c) => c.op === "create")?.name;
    expect(created).toMatch(/^mcp-/);
    // A DELETE on the session is the HTTP equivalent of stdin EOF: without
    // this the machine outlives the client that asked for it and keeps billing.
    await transport.terminateSession();
    await client.close();
    await expect.poll(() => backend.calls.some((c) => c.op === "delete" && c.name === created)).toBe(true);
    expect(backend.machines.size).toBe(0);
  });

  it("answers 404 off the configured path and 400 for a body that is not an initialize", async () => {
    const { url } = await start();
    const wrong = await fetch(url.replace("/mcp", "/nope"), { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "{}" });
    expect(wrong.status).toBe(404);
    const missing = (await wrong.json()) as { error: { message: string } };
    expect(missing.error.message).toMatch(/it is at \/mcp/);
    const stray = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(stray.status).toBe(400);
  });
});

describe("applyArgs", () => {
  it("overrides host, port and path", () => {
    const cfg = applyArgs(testConfig(), ["--host", "0.0.0.0", "--port", "9000", "--path", "/x"]);
    expect([cfg.httpHost, cfg.httpPort, cfg.httpPath]).toEqual(["0.0.0.0", 9000, "/x"]);
  });

  it("rejects a bad flag, a missing value, a non-numeric port and a bare path", () => {
    expect(() => applyArgs(testConfig(), ["--porc", "1"])).toThrow(/unknown argument/);
    expect(() => applyArgs(testConfig(), ["--port"])).toThrow(/needs a value/);
    expect(() => applyArgs(testConfig(), ["--port", "http"])).toThrow(/positive integer/);
    expect(() => applyArgs(testConfig(), ["--path", "mcp"])).toThrow(/start with a slash/);
  });
});
