#!/usr/bin/env node
// stdio entry point. On stdin EOF (the client went away) delete the
// ephemeral machines this process created, stop the serve it started, exit.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = await createServer({ cfg });
  const transport = new StdioServerTransport();

  let exiting = false;
  const exit = async (reason: string, code: number) => {
    if (exiting) return;
    exiting = true;
    process.stderr.write(`smol-mcp: ${reason}, cleaning up\n`);
    try {
      await app.shutdown();
    } catch (err) {
      process.stderr.write(`smol-mcp: cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    process.exit(code);
  };

  transport.onclose = () => void exit("stdio closed", 0);
  process.stdin.on("end", () => void exit("stdin EOF", 0));
  process.on("SIGINT", () => void exit("SIGINT", 130));
  process.on("SIGTERM", () => void exit("SIGTERM", 143));

  await app.server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`smol-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
