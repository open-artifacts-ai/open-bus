import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
    // @ob/setup runs its own suite via `pnpm -r test`.
    exclude: ["scripts/setup/**", "**/node_modules/**"],
  },
});
