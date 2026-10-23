import { defineConfig } from "vitest/config";

// `pnpm e2e:staging`: the spec scenarios against E2E_HUB. Never part of `pnpm test`.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["scenarios.test.ts"],
    environment: "node",
    // Staging is one shared hub: scenarios run one at a time.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
