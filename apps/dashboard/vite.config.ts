import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

const target = "http://localhost:8787";

export default defineConfig({
  plugins: [
    react(),
    // Tailwind 4 for the @ob/ui/shadcn components (src/shadcn.css).
    tailwindcss(),
    {
      // The MSW worker is a dev/e2e artifact; never ship it.
      name: "ob-drop-mock-worker",
      apply: "build",
      buildStart() {
        // The page would boot into a worker that is deleted below: blank screen.
        const flag =
          process.env.VITE_MOCK ??
          loadEnv("production", process.cwd()).VITE_MOCK;
        if (flag === "1") {
          throw new Error(
            "VITE_MOCK=1 is dev/e2e only; a production build must not enable mocks.",
          );
        }
      },
      closeBundle() {
        rmSync(new URL("./dist/mockServiceWorker.js", import.meta.url), {
          force: true,
        });
      },
    },
  ],
  resolve: {
    // Resolve the workspace contract from source so no prior shared build is needed.
    alias: [
      {
        find: /^@ob\/shared$/,
        replacement: fileURLToPath(
          new URL("../../packages/shared/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@ob\/shared\/(.*)$/,
        replacement: `${fileURLToPath(new URL("../../packages/shared/src", import.meta.url))}/$1`,
      },
    ],
  },
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
