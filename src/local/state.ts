// The record of ephemeral machines this server created, so a stdio EOF (or
// the next start, after a crash) can delete them. Only names carrying the
// prefix are ever deleted from here.
//
// Ownership is a session, not a process. One process hosts many sessions over
// the HTTP transport, and keying by pid made every session in it the owner of
// every other session's machines, so the first one to close deleted them all.
// The pid is still recorded, because a name whose process is gone is a name
// nobody will ever come back for.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { EphemeralStore } from "../machines.js";

const StateSchema = z.object({
  // `id` is what the backend's own delete route takes. Locally it is the
  // name; on a target that addresses a machine by something else it is that.
  machines: z.array(z.object({ name: z.string(), id: z.string().default(""), owner: z.string().default(""), pid: z.number(), createdAt: z.number() })),
});
export type State = z.infer<typeof StateSchema>;

export class StateFile implements EphemeralStore {
  constructor(readonly path: string) {}

  static inRuntimeDir(dir: string): StateFile {
    return new StateFile(join(dir, "machines.json"));
  }

  read(): State {
    if (!existsSync(this.path)) return { machines: [] };
    try {
      return StateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      return { machines: [] };
    }
  }

  private write(state: State): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.path);
  }

  add(name: string, owner: string, id = name, pid = process.pid): void {
    const s = this.read();
    if (!s.machines.some((m) => m.name === name)) s.machines.push({ name, id, owner, pid, createdAt: Date.now() });
    this.write(s);
  }

  remove(name: string): void {
    const s = this.read();
    s.machines = s.machines.filter((m) => m.name !== name);
    this.write(s);
  }

  // Names this session recorded, plus names left behind by a process that no
  // longer exists. A live process's other sessions are nobody else's to
  // delete, so they are not in here.
  owned(owner: string, isAlive: (pid: number) => boolean = pidAlive): { name: string; id: string }[] {
    return this.read()
      .machines.filter((m) => m.owner === owner || !isAlive(m.pid))
      .map((m) => ({ name: m.name, id: m.id === "" ? m.name : m.id }));
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
