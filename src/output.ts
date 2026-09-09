// Output shaping shared by run-command and run-once.
import type { ExecResult } from "./backend.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  timedOut: boolean;
}

// Keep the head of each stream up to maxBytes (measured in UTF-8 bytes), and
// say so; a client that gets a silently cut log reads it as complete.
export function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  const head = buf.subarray(0, maxBytes).toString("utf8").replace(/�$/, "");
  return { text: `${head}\n[truncated: ${buf.length - maxBytes} more bytes]`, truncated: true };
}

// The API reports a server-side timeout as exit 124 with a marker on stderr.
export function shapeResult(r: ExecResult, maxBytes: number): CommandResult {
  const out = truncate(r.stdout, maxBytes);
  const err = truncate(r.stderr, maxBytes);
  return {
    stdout: out.text,
    stderr: err.text,
    exitCode: r.exitCode,
    truncated: out.truncated || err.truncated,
    timedOut: r.exitCode === 124 && r.stderr.includes("command timed out"),
  };
}

// Accept either an argv array or a shell string.
export function toArgv(command: string | string[]): string[] {
  return Array.isArray(command) ? command : ["sh", "-c", command];
}
