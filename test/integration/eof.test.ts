// The stdio contract, driven by the official MCP client against the built
// binary: a machine created through a tool call must be gone once the client
// goes away, and a serve this server did not start must still be listening.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ensureServe } from "../../src/local/serve.js";
import type { ServeHandle } from "../../src/local/serve.js";
import { IMAGE, LOCAL_IT, itConfig } from "./harness.js";

const suite = LOCAL_IT ? describe : describe.skip;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let serve: ServeHandle;

beforeAll(async () => {
  if (!LOCAL_IT) return;
  // Started here, outside the server under test, so there is still something
  // to ask after the client has gone.
  serve = await ensureServe(itConfig(), () => {});
});

afterAll(async () => {
  if (!LOCAL_IT) return;
  await serve.stop();
});

async function connect() {
  const client = new Client({ name: "smol-mcp-it", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, "dist/cli.js")],
    env: { ...process.env, SMOL_LOCAL_URL: serve.url } as Record<string, string>,
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

function structured<T>(res: unknown): T {
  return (res as { structuredContent: T }).structuredContent;
}

suite("stdio EOF", () => {
  it("advertises the whole vocabulary and reaches the same serve", async () => {
    const { client, transport } = await connect();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "branch-machine",
          "create-machine",
          "delete-machine",
          "get-machine",
          "list-machines",
          "machine-logs",
          "pull-image",
          "read-file",
          "run-command",
          "run-once",
          "start-machine",
          "stop-machine",
          "write-file",
        ].sort(),
      );
      const listed = structured<{ machines: unknown[] }>(await client.callTool({ name: "list-machines", arguments: { target: "local" } }));
      expect(Array.isArray(listed.machines)).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it("deletes the machines it created when stdin closes, and leaves a serve it did not start", async () => {
    const { client, transport } = await connect();
    const created = structured<{ machine: { name: string }; ephemeral: boolean }>(
      await client.callTool({ name: "create-machine", arguments: { target: "local", image: IMAGE, network: "open" } }),
    );
    expect(created.ephemeral).toBe(true);
    expect(created.machine.name.startsWith("mcp-")).toBe(true);
    expect((await serve.client.listMachines()).map((x) => x.name)).toContain(created.machine.name);

    // Closing the transport closes the child's stdin, which is the only
    // shutdown signal a stdio client sends.
    await transport.close();
    const deadline = Date.now() + 120_000;
    let names: string[] = [];
    do {
      await new Promise((r) => setTimeout(r, 1000));
      names = (await serve.client.listMachines()).map((x) => x.name);
    } while (names.includes(created.machine.name) && Date.now() < deadline);
    expect(names).not.toContain(created.machine.name);
    // The serve was already listening, so the server used it and left it up.
    expect((await serve.client.health()).status).toBe("ok");
  });
});
