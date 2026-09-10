// The runtime directory holds the socket of an API that creates virtual
// machines with no authentication of its own, so who owns the directory is
// who can reach that API.
import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateFile, StateUnreadable } from "../../src/local/state.js";
import { ensureRuntimeDir } from "../../src/local/runtime-dir.js";

const fresh = () => join(mkdtempSync(join(tmpdir(), "smol-mcp-rd-")), "runtime");

describe("ensureRuntimeDir", () => {
  it("creates it 0700, and creating the parents on the way", () => {
    const dir = join(fresh(), "deeper");
    ensureRuntimeDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("accepts a directory it already made", () => {
    const dir = fresh();
    ensureRuntimeDir(dir);
    expect(() => ensureRuntimeDir(dir)).not.toThrow();
  });

  it("refuses one that others can write to, which mkdir -p would have accepted", () => {
    // mkdirSync with a mode does nothing to a directory that already exists,
    // so a path pre-created in a world-writable parent kept its own mode and
    // its own owner, and the socket went in anyway.
    const dir = fresh();
    mkdirSync(dir, { mode: 0o777 });
    chmodSync(dir, 0o777);
    expect(() => ensureRuntimeDir(dir)).toThrow(/must be 700/);
  });

  it("does not read POSIX mode bits as a permission model on Windows", () => {
    // node reports 666 for a directory nobody else can touch there, so this
    // check refused every run on that platform. The socket it guards does not
    // exist there either: the serve listens on loopback TCP.
    const dir = fresh();
    mkdirSync(dir, { mode: 0o777 });
    chmodSync(dir, 0o777);
    expect(() => ensureRuntimeDir(dir, "win32")).not.toThrow();
    expect(() => ensureRuntimeDir(dir, "darwin")).toThrow(/must be 700/);
  });

  it("refuses a path that is not a directory", () => {
    const dir = fresh();
    mkdirSync(join(dir, ".."), { recursive: true });
    writeFileSync(dir, "");
    expect(() => ensureRuntimeDir(dir)).toThrow(/not a directory/);
  });
});

describe("the machine record when it cannot be read", () => {
  it("says so rather than answering that there are no machines", () => {
    // Answering "no machines" to a corrupt file makes every ephemeral machine
    // unowned, so nothing deletes them and nothing says they are still there.
    const dir = fresh();
    ensureRuntimeDir(dir);
    const state = StateFile.inRuntimeDir(dir);
    state.add("mcp-a", "a-session");
    writeFileSync(state.path, "{ this is not json");
    expect(() => state.read()).toThrow(StateUnreadable);
    expect(() => state.owned("a-session")).toThrow(/may still be running/);
  });

  it("reads a record it wrote", () => {
    const dir = fresh();
    ensureRuntimeDir(dir);
    const state = StateFile.inRuntimeDir(dir);
    state.add("mcp-a", "a-session");
    // The record carries the id the backend's delete route takes; locally it
    // is the name.
    expect(state.owned("a-session")).toEqual([{ name: "mcp-a", id: "mcp-a" }]);
  });
});
