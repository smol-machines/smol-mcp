// The directory this server keeps its socket, its log and its machine record
// in. Everything in it is reachable by anything that can reach the socket,
// and the socket is an unauthenticated API that creates virtual machines.
//
// mkdir -p with a mode is not a claim of ownership: it does nothing at all to
// a directory that already exists, so on a shared host in a world-writable
// parent another user can create the path first and own everything put in it
// afterwards. The directory is therefore created exclusively, and one that is
// already there is checked rather than trusted.
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

export class RuntimeDirRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeDirRefused";
  }
}

export function ensureRuntimeDir(dir: string): void {
  try {
    mkdirSync(dirname(dir), { recursive: true });
    mkdirSync(dir, { mode: 0o700 });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const stat = statSync(dir);
  if (!stat.isDirectory()) throw new RuntimeDirRefused(`${dir} exists and is not a directory; set SMOL_MCP_RUNTIME_DIR to somewhere else`);
  // getuid is absent on Windows, where the same attack needs a different
  // check and the path is not a world-writable /tmp.
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new RuntimeDirRefused(`${dir} belongs to uid ${stat.uid} and this process runs as ${uid}; refusing to put a socket in a directory another user owns. Set SMOL_MCP_RUNTIME_DIR to somewhere else.`);
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new RuntimeDirRefused(`${dir} is mode ${mode.toString(8)} and must be 700: anything that can reach the socket in it can create a machine on this host. Fix the mode, or set SMOL_MCP_RUNTIME_DIR to somewhere else.`);
  }
}
