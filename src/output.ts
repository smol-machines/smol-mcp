// Output shaping shared by run-command and run-once.
import type { ExecResult } from "./backend.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  timedOut: boolean;
  // Where a stream too big for the result was written inside the machine,
  // and how many bytes it holds. Empty when nothing was dropped.
  overflow: Overflow[];
}

export interface Overflow {
  stream: "stdout" | "stderr";
  path: string;
  bytes: number;
}

// Keep the head and the tail of a stream inside maxBytes (measured in UTF-8
// bytes) and say what was dropped between them. The head alone loses the line
// a failing command ends on, which is usually the one the caller wanted.
const HEAD_SHARE = 2 / 3;

export function truncate(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false, bytes: buf.length };
  const headBytes = Math.max(1, Math.floor(maxBytes * HEAD_SHARE));
  const tailBytes = Math.max(0, maxBytes - headBytes);
  // A cut can land inside a multi-byte character; the replacement character
  // it decodes to is dropped rather than left in the payload as damage.
  const head = buf.subarray(0, headBytes).toString("utf8").replace(/�$/, "");
  const tail = tailBytes === 0 ? "" : buf.subarray(buf.length - tailBytes).toString("utf8").replace(/^�/, "");
  return { text: `${head}\n[... ${buf.length - headBytes - tailBytes} bytes dropped ...]\n${tail}`, truncated: true, bytes: buf.length };
}

// The API reports a server-side timeout as exit 124 with a marker on stderr.
//
// `truncated` covers both cuts: the client-side budget below, and the one the
// API made before this ever saw the bytes. A result that reports only the
// first tells a caller its output is complete when a megabyte of it is gone.
export function shapeResult(r: ExecResult, maxBytes: number): CommandResult {
  const out = truncate(r.stdout, maxBytes);
  const err = truncate(r.stderr, maxBytes);
  const serverSide = r.stdoutTruncated === true || r.stderrTruncated === true;
  return {
    stdout: out.text,
    stderr: err.text,
    exitCode: r.exitCode,
    truncated: out.truncated || err.truncated || serverSide,
    timedOut: r.exitCode === 124 && r.stderr.includes("command timed out"),
    overflow: [],
  };
}

// The line that turns a dropped middle into something the caller can go and
// get. Appended after the spill, because the path is not known before it.
export function noteOverflow(text: string, o: Overflow): string {
  return `${text}\n[full ${o.stream}, ${o.bytes} bytes, is in the machine at ${o.path}]`;
}

// Accept either an argv array or a shell string.
export function toArgv(command: string | string[]): string[] {
  return Array.isArray(command) ? command : ["sh", "-c", command];
}
