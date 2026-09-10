// A real MCP client over Streamable HTTP against a server that is somewhere
// else. It speaks the protocol, not the library's internals: nothing here
// imports src/.
//
//   SMOL_MCP_AUTH_TOKEN=... node scripts/smoke-http.mjs http://127.0.0.1:8080/mcp
//   SMOL_MCP_AUTH_TOKEN=... node scripts/smoke-http.mjs http://b.local:8080/mcp
//   SMOL_MCP_AUTH_TOKEN=... SMOL_CLOUD_TOKEN=... node scripts/smoke-http.mjs \
//     https://<machine>-<hash>.apps.smolmachines.com/mcp
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Which header carries what.
//
// The server's own token goes in `authorization`, wherever the server is: on
// loopback, on another host across a network, anywhere. The one exception is a
// machine behind the cloud ingress, which spends `authorization` on the
// account key before the request reaches the guest, so there the account key
// goes in `authorization` and the server's token travels in
// `x-smol-mcp-token`. Setting SMOL_CLOUD_TOKEN is how a caller says it is
// going through an ingress.
//
// This used to decide on whether the URL was loopback, which made every
// address that was not loopback a cloud URL and refused to run at all without
// an account key. That is the two computer shape the README documents as the
// supported one, so the script could not be pointed at it.
export function smokeHeaders(token, cloudKey) {
  const headers = { "x-smol-mcp-token": token };
  headers.authorization = `Bearer ${cloudKey !== undefined && cloudKey !== "" ? cloudKey : token}`;
  return headers;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) {
  // Imported by a test: the helper above is the whole surface.
} else {

const url = process.argv[2];
if (!url) throw new Error("usage: node scripts/smoke-http.mjs <url of the MCP endpoint>");
const token = process.env.SMOL_MCP_AUTH_TOKEN;
if (!token) throw new Error("SMOL_MCP_AUTH_TOKEN is required: the server rejects every request without it");

const headers = smokeHeaders(token, process.env.SMOL_CLOUD_TOKEN);

const client = new Client({ name: "smol-mcp-http-smoke", version: "0" });
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
const connected = Date.now();
await client.connect(transport);
console.log(`$ connect ${url}   [${((Date.now() - connected) / 1000).toFixed(1)}s]`);
console.log(`session ${transport.sessionId}\n`);

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`$ tools/list\n${tools.join(" ")}\n`);

// The target argument exists only when this server reaches both fleets; in a
// single-target mode it is not in the schema and the server decides.
const listed = (await client.listTools()).tools.find((t) => t.name === "run-once");
const servesBoth = Object.keys(listed?.inputSchema?.properties ?? {}).includes("target");
const target = servesBoth ? { target: process.env.SMOL_MCP_SMOKE_TARGET ?? "cloud" } : {};
const image = process.env.SMOL_MCP_IT_CLOUD_IMAGE ?? "alpine:3.20";

for (const call of [
  { name: "list-machines", arguments: { ...target } },
  // network open because the image is pulled from a registry, and on the
  // local fleet that pull happens inside the guest.
  { name: "run-once", arguments: { ...target, image, command: "echo hello", cpus: 1, memoryMb: 256, network: "open" } },
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

}
