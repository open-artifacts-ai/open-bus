import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const target = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
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
