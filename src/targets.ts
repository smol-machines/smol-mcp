// What an agent has to know before its first call: which fleets this process
// can reach, and what each one cannot do. Both the server's `instructions`
// string and the `smol://targets` resource are rendered from here, so a
// capability that changes is edited once.
import type { Config, TargetMode } from "./config.js";
import { localUnavailable } from "./local/serve.js";

export const TARGETS_URI = "smol://targets";

export interface TargetInfo {
  target: "local" | "cloud";
  // Whether this process serves the target at all. A target that is not
  // served has no tool argument that can name it.
  served: boolean;
  // Why a served target would fail on this host, or null when nothing known
  // stands in its way. Local can be served and still unusable.
  unavailable: string | null;
  summary: string;
  cannot: string[];
}

export function targetInfos(mode: TargetMode, cfg: Config): TargetInfo[] {
  return [
    {
      target: "local",
      served: mode !== "cloud",
      unavailable: localUnavailable(cfg) ?? null,
      summary: "smolvm serve on the host this process runs on, over a Unix socket in its runtime directory. The serve is started on the first local call and stopped when this server exits.",
      cannot: [
        "run where there is no hypervisor and no smolvm binary, which includes inside a smol machine guest",
        "report a bill: the local API meters nothing",
        "outlive this server for an ephemeral mcp- machine, which is deleted when the session ends",
      ],
    },
    {
      target: "cloud",
      served: mode !== "local",
      unavailable: cfg.cloudToken === "" ? "no SMOL_CLOUD_TOKEN is configured" : null,
      summary: `the smol cloud REST API at ${cfg.cloudUrl}, with a bearer token. Machines run in the service, not on this host.`,
      cannot: [
        "tail a console log: machine-logs is refused on this target",
        "pull an image into a machine: the control plane pulls at create, and pull-image is refused",
        "take a workload command at create: the cloud create request has no cmd field, so create-machine drops it",
        "run for free: every machine bills for as long as it exists",
      ],
    },
  ];
}

export function serverInstructions(mode: TargetMode, cfg: Config): string {
  const infos = targetInfos(mode, cfg).filter((t) => t.served);
  const lines: string[] = [];
  lines.push(
    mode === "both"
      ? "This server runs commands and files in virtual machines on two fleets, local and cloud. Every tool takes a required `target` argument naming one of them: there is no default, because a machine on one fleet is invisible on the other and the two bill differently."
      : `This server runs commands and files in virtual machines on the ${mode} fleet only. There is no target argument: every call goes to that fleet.`,
  );
  for (const info of infos) {
    lines.push("");
    lines.push(`${info.target}: ${info.summary}`);
    if (info.unavailable !== null) lines.push(`Not usable right now: ${info.unavailable}.`);
    lines.push(`It cannot ${info.cannot.join("; it cannot ")}.`);
  }
  lines.push("");
  lines.push(`The same facts, machine readable and re-read at any time, are the ${TARGETS_URI} resource.`);
  return lines.join("\n");
}
