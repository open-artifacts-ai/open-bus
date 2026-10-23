import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // Node-only checks (fs over repo files) run under vitest.node.config.ts.
    exclude: ["test/**/*.node.test.ts", "**/node_modules/**"],
  },
});
