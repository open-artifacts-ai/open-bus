import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
    // @ob/setup runs its own suite via `pnpm -r test`; e2e/** runs only via
    // `pnpm e2e:staging` (its harness self-test is scripts/e2e-harness.test.ts).
    exclude: ["scripts/setup/**", "e2e/**", "**/node_modules/**"],
  },
});
