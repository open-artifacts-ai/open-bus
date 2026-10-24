// Starts the Worker for the real-server suite (playwright.real.config.ts's
// webServer, local mode only): resets local state, builds the dashboard, then
// runs the server's own `dev:e2e` (wrangler.e2e.jsonc: loopback only, never
// deployed) with CLI flags layered on: https, ENVIRONMENT=dev placeholder vars
// and the built dashboard as assets.
//   node e2e/real/serve.mjs <port>
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// dev:e2e hard-codes --port 8787 (and wrangler takes one --port), so that is the port.
const port = process.argv[2] ?? "8787";
if (port !== "8787") {
  console.error(
    "serve.mjs: dev:e2e only listens on 8787; set OB_E2E_BASE accordingly",
  );
  process.exit(1);
}
const root = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

const run = (...args) => {
  const r = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run("--filter", "@ob/server", "dev:e2e:reset");
run("--filter", "@ob/shared", "build");
run("--filter", "@ob/dashboard", "build");

const vars = {
  ENVIRONMENT: "dev",
  APP_HOST: `127.0.0.1:${port}`,
  OWNER_EMAIL: "owner@example.com",
  ACCESS_TEAM_DOMAIN: "team.example.cloudflareaccess.com",
  ACCESS_CLIENT_ID: "dev-client",
  ACCESS_CLIENT_SECRET: "dev-secret",
  SESSION_SECRET: "dev-session-secret-0123456789abcdef-xyz",
};
const child = spawn(
  "pnpm",
  [
    "--filter",
    "@ob/server",
    "dev:e2e",
    "--local-protocol",
    "https",
    "--assets",
    resolve(root, "apps/dashboard/dist"),
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
  ],
  { cwd: root, stdio: "inherit" },
);
const stop = (code) => {
  child.kill("SIGTERM");
  process.exit(code);
};
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
child.on("exit", (code) => stop(code ?? 1));
