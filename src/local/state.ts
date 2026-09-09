// The record of ephemeral machines this server created, so a stdio EOF (or
// the next start, after a crash) can delete them. Only names carrying the
// prefix are ever deleted from here.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const StateSchema = z.object({
  machines: z.array(z.object({ name: z.string(), pid: z.number(), createdAt: z.number() })),
});
export type State = z.infer<typeof StateSchema>;

export class StateFile {
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

  add(name: string, pid = process.pid): void {
    const s = this.read();
    if (!s.machines.some((m) => m.name === name)) s.machines.push({ name, pid, createdAt: Date.now() });
    this.write(s);
  }

  remove(name: string): void {
    const s = this.read();
    s.machines = s.machines.filter((m) => m.name !== name);
    this.write(s);
  }

  // Names recorded by this pid, plus names whose recording pid is gone.
  owned(pid = process.pid, isAlive: (pid: number) => boolean = pidAlive): string[] {
    return this.read()
      .machines.filter((m) => m.pid === pid || !isAlive(m.pid))
      .map((m) => m.name);
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
