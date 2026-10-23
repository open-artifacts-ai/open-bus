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
    // Hub tests drive a real Durable Object (100+ machines, 300 sends, real
    // sockets). Under a full parallel `pnpm test` they brushed the 5 s default;
    // none of them asserts on time, so a generous bound only removes flakes.
    testTimeout: 30_000,
  },
});
