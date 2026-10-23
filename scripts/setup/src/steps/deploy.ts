import { isAbsolute, join } from "node:path";
import { withoutTokens } from "../cf.ts";
import { parseJsonc } from "../jsonc.ts";
import type { ActionRequired, Opts, Step } from "../step.ts";
import { repoVersion } from "../version.ts";

export const SERVER_DIR = "apps/server";
const CONFIG = "wrangler.jsonc";
const DIST_INDEX = "apps/dashboard/dist/index.html";
/** Only what the Worker bundles and serves: the dashboard and its workspace deps. */
export const BUILD = ["--filter", "@ob/dashboard...", "build"];

/**
 * `wrangler deploy` argv, run from apps/server against `config`, the path of
 * the config `renderConfig` wrote (never the checked-in wrangler.jsonc, whose
 * routes bind staging). Every var is passed as `--var NAME:value`.
 * No `--domain`: wrangler (4.152, what apps/server resolves) merges `--domain`
 * into the config's own routes, which would also bind the checked-in
 * staging.open-bus.ai. The rendered config's `routes` is exactly
 * `[{ pattern: host, custom_domain: true }]` instead.
 */
export function deployArgs(
  opts: Pick<Opts, "name" | "host" | "ownerEmail">,
  access: { teamDomain: string; clientId: string },
  version: string,
  config: string,
): string[] {
  const vars = {
    ENVIRONMENT: "production",
    APP_HOST: opts.host,
    OWNER_EMAIL: opts.ownerEmail,
    ACCESS_TEAM_DOMAIN: access.teamDomain,
    ACCESS_CLIENT_ID: access.clientId,
    VERSION: version,
  };
  return [
    ...["deploy", "-c", config, "--name", opts.name],
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
  ];
}

/**
 * apps/server/wrangler.jsonc (in `dir`) with `name` and `routes` set for this
 * instance, and `main` and `assets.directory` made absolute so it can live in a
 * temp directory.
 */
export function renderConfig(
  text: string,
  dir: string,
  name: string,
  host: string,
) {
  const cfg = parseJsonc(text) as Record<string, unknown>;
  const abs = (p: unknown) =>
    typeof p === "string" && !isAbsolute(p) ? join(dir, p) : p;
  const assets = cfg.assets as Record<string, unknown> | undefined;
  return `${JSON.stringify(
    {
      ...cfg,
      name,
      ...(cfg.main !== undefined ? { main: abs(cfg.main) } : {}),
      ...(assets
        ? { assets: { ...assets, directory: abs(assets.directory) } }
        : {}),
      routes: [{ pattern: host, custom_domain: true }],
    },
    null,
    2,
  )}\n`;
}

export const deploy: Step = {
  name: "deploy",
  async check(state, ctx) {
    // Every install run redeploys (cheap, idempotent); --check reports drift only.
    if (!ctx.opts.check) return "todo";
    const version = repoVersion(ctx);
    if (state.deployedVersion === version) return "done";
    ctx.notes.push(
      state.deployedVersion
        ? `deployed ${state.deployedVersion}, repo is ${version}`
        : `Worker ${ctx.opts.name} never deployed`,
    );
    return "todo";
  },
  async apply(state, ctx): Promise<ActionRequired | undefined> {
    const dir = join(ctx.root, SERVER_DIR);
    const text = ctx.fs.read(join(dir, CONFIG));
    if (text === null)
      throw new Error(
        `missing ${SERVER_DIR}/${CONFIG}; is this the repo root?`,
      );
    if (!state.teamDomain || !state.accessClientId)
      throw new Error(
        "no Access app in state (teamDomain, accessClientId); rerun setup so the access step records it",
      );
    const version = repoVersion(ctx);
    // The build never sees an API token: its whole env is this one.
    const b = await ctx.deps.exec("pnpm", BUILD, {
      cwd: ctx.root,
      env: withoutTokens(ctx.deps.env),
      replaceEnv: true,
      timeoutMs: 600_000,
    });
    if (b.code !== 0)
      throw new Error(`pnpm build failed: ${(b.stderr || b.stdout).trim()}`);
    if (ctx.fs.read(join(ctx.root, DIST_INDEX)) === null)
      throw new Error(
        `the build left no ${DIST_INDEX}; fix the dashboard build, then rerun`,
      );
    if (!ctx.fs.tempDir || !ctx.fs.removeTree)
      throw new Error("this fs cannot make a temp directory");
    // The rendered config lives in a temp dir, removed whatever happens.
    const tmp = ctx.fs.tempDir();
    try {
      const config = join(tmp, "wrangler.json");
      ctx.fs.write(
        config,
        renderConfig(text, dir, ctx.opts.name, ctx.opts.host),
      );
      await ctx.wrangler(
        deployArgs(
          ctx.opts,
          { teamDomain: state.teamDomain, clientId: state.accessClientId },
          version,
          config,
        ),
        { cwd: dir, timeoutMs: 600_000 },
      );
    } finally {
      ctx.fs.removeTree(tmp);
    }
    state.deployedVersion = version;
    state.host = ctx.opts.host;
    ctx.notes.push(`deployed ${version} to ${ctx.opts.host}`);
    ctx.data = { version, host: ctx.opts.host };
    return undefined;
  },
};
