// One `smolvm serve` per process, handed out by reference count.
//
// Only one serve can run per host, so every session in a process shares one.
// The session that happened to start it is not the one that may stop it: over
// the HTTP transport that session can close while three others are still
// holding clients to the same socket, and stopping the child there answers
// their next call with ECONNREFUSED. The last release stops it instead.
import type { ServeHandle } from "./serve.js";

interface Entry {
  started: Promise<ServeHandle>;
  refs: number;
}

export class ServePool {
  private readonly entries = new Map<string, Entry>();

  // The handle returned here has the same shape as a private one, and its
  // stop() releases this reference rather than killing the child.
  async acquire(key: string, start: () => Promise<ServeHandle>): Promise<ServeHandle> {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { started: start(), refs: 0 };
      this.entries.set(key, entry);
    }
    const held = entry;
    held.refs += 1;
    let handle: ServeHandle;
    try {
      handle = await held.started;
    } catch (err) {
      // A start that failed is not a serve anyone can share, and leaving the
      // rejected promise in the map would fail every later session with a
      // stale error.
      this.drop(key, held);
      throw err;
    }
    let released = false;
    return {
      ...handle,
      stop: async () => {
        if (released) return;
        released = true;
        if (this.drop(key, held)) await handle.stop();
      },
    };
  }

  private drop(key: string, entry: Entry): boolean {
    entry.refs -= 1;
    if (entry.refs > 0) return false;
    if (this.entries.get(key) === entry) this.entries.delete(key);
    return true;
  }

  // Holders of the serve under this key, for a test or a log line.
  refs(key: string): number {
    return this.entries.get(key)?.refs ?? 0;
  }
}

// The process-wide one. A test builds its own.
export const serves = new ServePool();
