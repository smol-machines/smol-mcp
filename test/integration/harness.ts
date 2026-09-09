// Shared setup for the tests that talk to something real. Integration is
// opt-in: without SMOL_MCP_IT=1 the suites skip rather than fail, because a
// clean clone on a host with no hypervisor and no cloud key should still be
// able to run `npm test`.
import { loadConfig } from "../../src/config.js";
import type { Config } from "../../src/config.js";

export const LOCAL_IT = process.env.SMOL_MCP_IT === "1";
export const CLOUD_IT = LOCAL_IT && (process.env.SMOL_CLOUD_TOKEN ?? "") !== "";

// Small and quick to boot. busybox is in the image, which is all the assertions
// need, and nothing here depends on a package manager.
export const IMAGE = process.env.SMOL_MCP_IT_IMAGE ?? "alpine";

export function itConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig(), ...overrides };
}

// Every machine an integration test makes carries this prefix, so a leak is
// visible by name on either target and the sweep at the end of a run has an
// unambiguous thing to look for.
export const IT_PREFIX = "mcp-";

export function unique(kind: string): string {
  return `${IT_PREFIX}it-${kind}-${Math.random().toString(16).slice(2, 8)}`;
}
