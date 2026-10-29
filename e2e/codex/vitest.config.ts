import { defineConfig } from "vitest/config";

// `pnpm e2e:codex`: the real Codex CLI against a fake model (C26g). Never part
// of `pnpm test`: it builds the CLI bundle and installs the pinned Codex.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["codex.test.ts"],
    globalSetup: ["setup.ts"],
    environment: "node",
    // One stack (server, daemon, CODEX_HOME) shared by ordered scenarios.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
