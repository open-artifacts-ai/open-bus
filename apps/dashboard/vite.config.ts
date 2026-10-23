import { rmSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const target = "http://localhost:8787";

export default defineConfig({
  plugins: [
    react(),
    {
      // The MSW worker is a dev/e2e artifact; never ship it.
      name: "ob-drop-mock-worker",
      apply: "build",
      closeBundle() {
        rmSync(new URL("./dist/mockServiceWorker.js", import.meta.url), {
          force: true,
        });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": target,
      "/auth": target,
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    // Dates render the same on every machine and CI runner.
    env: { TZ: "UTC" },
    projects: [
      {
        extends: true,
        test: { name: "node", include: ["test/**/*.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["test/**/*.test.tsx"],
          setupFiles: ["test/setup.ts"],
          testTimeout: 15_000,
        },
      },
    ],
  },
});
