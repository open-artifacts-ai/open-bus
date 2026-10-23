import { defineConfig } from "vitest/config";

/** Checks that need Node (fs over repo files), not workerd. */
export default defineConfig({
  test: {
    include: ["test/**/*.node.test.ts"],
    environment: "node",
  },
});
