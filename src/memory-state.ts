// The ephemeral record for a target that keeps none for us. A cloud machine
// this session created is known only here, so the session that created it is
// the only thing that can delete it; a process that dies with entries in here
// leaves them to the control plane's own autoStopSeconds and ttlSeconds.
import type { EphemeralStore } from "./machines.js";

export class MemoryStore implements EphemeralStore {
  private readonly entries = new Map<string, { owner: string; id: string }>();

  add(name: string, owner: string, id = name): void {
    if (!this.entries.has(name)) this.entries.set(name, { owner, id });
  }

  remove(name: string): void {
    this.entries.delete(name);
  }

  owned(owner: string): { name: string; id: string }[] {
    return [...this.entries.entries()].filter(([, e]) => e.owner === owner).map(([name, e]) => ({ name, id: e.id }));
  }

  get size(): number {
    return this.entries.size;
  }
}
