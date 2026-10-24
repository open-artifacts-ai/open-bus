// Starts the Worker for the real-server suite (playwright.real.config.ts's
// webServer, local mode only): builds the dashboard, then `wrangler dev` over
// https on loopback with ENVIRONMENT=dev placeholders and fresh state.
//   node e2e/real/serve.mjs <port>
// The staging wrangler.jsonc is used with its `routes` removed (a route makes
// wrangler dev see the custom-domain host, and /auth/dev-login would 404). The
// temp config sits in the gitignored apps/server/.wrangler; vars go on the
// command line, so no secret-shaped file is written.
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const port = process.argv[2] ?? "8791";
const root = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const server = join(root, "apps/server");

const build = (filter) => {
  const r = spawnSync("pnpm", ["--filter", filter, "build"], {
    cwd: root,
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
build("@ob/shared");
build("@ob/dashboard");

// wrangler.jsonc is JSONC: strip comments (line comments only appear on their own lines).
const base = JSON.parse(
  readFileSync(join(server, "wrangler.jsonc"), "utf8").replace(
    /^\s*\/\/.*$/gm,
    "",
  ),
);
const { routes: _routes, ...rest } = base;
const dir = join(server, ".wrangler/e2e-real");
mkdirSync(dir, { recursive: true });
const config = join(dir, "wrangler.jsonc");
writeFileSync(
  config,
  JSON.stringify({
    ...rest,
    main: join(server, base.main),
    assets: { ...base.assets, directory: join(server, base.assets.directory) },
  }),
);
const state = mkdtempSync(join(tmpdir(), "ob-e2e-real-"));

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
    "exec",
    "wrangler",
    "dev",
    "-c",
    config,
    "--local",
    "--local-protocol",
    "https",
    "--ip",
    "127.0.0.1",
    "--port",
    port,
    "--persist-to",
    state,
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
  ],
  { cwd: server, stdio: "inherit" },
);
const stop = (code) => {
  child.kill("SIGTERM");
  rmSync(state, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
};
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
child.on("exit", (code) => stop(code ?? 1));
