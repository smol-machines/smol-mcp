import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests boot real microVMs; each one can take tens of seconds.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // One file at a time: the local API can run only one serve per host, and
    // the integration files share it.
    fileParallelism: false,
  },
});
