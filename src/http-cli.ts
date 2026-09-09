#!/usr/bin/env node
// Streamable HTTP entry point. A separate bin, so the stdio one keeps its
// contract: no port, no token, no listener.
//
//   SMOL_MCP_AUTH_TOKEN=... node dist/http-cli.js [--host H] [--port P] [--path /mcp]
import { loadConfig } from "./config.js";
import { applyArgs, startHttpTransport } from "./http-transport.js";

async function main(): Promise<void> {
  const cfg = applyArgs(loadConfig(), process.argv.slice(2));
  const handle = await startHttpTransport({ cfg });

  let exiting = false;
  const exit = async (reason: string, code: number) => {
    if (exiting) return;
    exiting = true;
    process.stderr.write(`smol-mcp: ${reason}, cleaning up\n`);
    try {
      await handle.close();
    } catch (err) {
      process.stderr.write(`smol-mcp: cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    process.exit(code);
  };
  process.on("SIGINT", () => void exit("SIGINT", 130));
  process.on("SIGTERM", () => void exit("SIGTERM", 143));
}

main().catch((err: unknown) => {
  process.stderr.write(`smol-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
