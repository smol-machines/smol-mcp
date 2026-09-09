// A real MCP client over stdio against the built server, used to produce the
// transcript in the README's Verified section. It speaks the protocol, not
// the library's internals: nothing here imports src/.
//
//   node scripts/smoke.mjs local
//   node scripts/smoke.mjs cloud     # needs SMOL_CLOUD_TOKEN
//   node scripts/smoke.mjs both
//   node scripts/smoke.mjs guest     # run INSIDE a machine: local must refuse
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2] ?? "both";
const image = { local: process.env.SMOL_MCP_IT_IMAGE ?? "alpine", cloud: process.env.SMOL_MCP_IT_CLOUD_IMAGE ?? "alpine:3.20" };

const list = (target) => ({ name: "list-machines", arguments: { target } });
// Smallest shape the cloud plan bills for; the local target ignores both.
// network open because the image is pulled from a registry: on the local
// target that pull happens inside the guest, so a machine with the default no
// egress cannot start from one. See the README's egress section.
const runOnce = (target) => ({ name: "run-once", arguments: { target, image: image[target], command: "echo hello", cpus: 1, memoryMb: target === "cloud" ? 256 : 2048, network: "open" } });
const plan = {
  local: [list("local"), runOnce("local")],
  cloud: [list("cloud"), runOnce("cloud")],
  // Inside a machine there is no hypervisor and no smolvm, so the local call
  // has to come back as a refusal with a reason. It is in this transcript
  // because a hang there is indistinguishable from a slow boot.
  guest: [list("local"), list("cloud"), runOnce("cloud")],
};
plan.both = [...plan.local, ...plan.cloud];
const calls = plan[which];
if (calls === undefined) throw new Error(`unknown mode ${which} (local, cloud, both, guest)`);

const client = new Client({ name: "smol-mcp-smoke", version: "0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, "dist/cli.js")],
  env: process.env,
  stderr: "inherit",
});
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`$ tools/list\n${tools.join(" ")}\n`);

for (const call of calls) {
  const started = Date.now();
  const res = await client.callTool(call);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`$ tools/call ${call.name} ${JSON.stringify(call.arguments)}   [${secs}s]`);
  console.log(res.isError ? `ERROR ${res.content[0].text}` : JSON.stringify(res.structuredContent, null, 2));
  console.log("");
}

// Closing stdin is the shutdown signal: the server deletes the ephemeral
// machines it created and stops a serve it started.
await transport.close();
