// A real MCP client over Streamable HTTP against a server that is somewhere
// else, used to produce the README's Shape B transcript. It speaks the
// protocol, not the library's internals: nothing here imports src/.
//
//   SMOL_MCP_AUTH_TOKEN=... node scripts/smoke-http.mjs http://127.0.0.1:8080/mcp
//   SMOL_MCP_AUTH_TOKEN=... SMOL_CLOUD_TOKEN=... node scripts/smoke-http.mjs \
//     https://<machine>-<hash>.apps.smolmachines.com/mcp
//
// Two headers for a cloud URL. A published machine sits behind an ingress
// that takes the account key in `authorization`, so the server's own token
// travels in `x-smol-mcp-token`. Loopback needs no account key and carries the
// server's token in `authorization`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2];
if (!url) throw new Error("usage: node scripts/smoke-http.mjs <url of the MCP endpoint>");
const token = process.env.SMOL_MCP_AUTH_TOKEN;
if (!token) throw new Error("SMOL_MCP_AUTH_TOKEN is required: the server rejects every request without it");

const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
const headers = { "x-smol-mcp-token": token };
if (loopback) {
  headers.authorization = `Bearer ${token}`;
} else {
  if (!process.env.SMOL_CLOUD_TOKEN) throw new Error("a cloud URL goes through the machine ingress, which answers 401 without SMOL_CLOUD_TOKEN in authorization");
  headers.authorization = `Bearer ${process.env.SMOL_CLOUD_TOKEN}`;
}

const client = new Client({ name: "smol-mcp-http-smoke", version: "0" });
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
const connected = Date.now();
await client.connect(transport);
console.log(`$ connect ${url}   [${((Date.now() - connected) / 1000).toFixed(1)}s]`);
console.log(`session ${transport.sessionId}\n`);

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`$ tools/list\n${tools.join(" ")}\n`);

for (const call of [
  { name: "list-machines", arguments: { target: "cloud" } },
  { name: "run-once", arguments: { target: "cloud", image: process.env.SMOL_MCP_IT_CLOUD_IMAGE ?? "alpine:3.20", command: "echo hello", cpus: 1, memoryMb: 256 } },
]) {
  const started = Date.now();
  const res = await client.callTool(call);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`$ tools/call ${call.name} ${JSON.stringify(call.arguments)}   [${secs}s]`);
  console.log(res.isError ? `ERROR ${res.content[0].text}` : JSON.stringify(res.structuredContent, null, 2));
  console.log("");
}

// Ending the session is what deletes this session's ephemeral machines; the
// HTTP equivalent of closing stdin.
await transport.terminateSession();
await client.close();
console.log("smol-mcp: session terminated");
