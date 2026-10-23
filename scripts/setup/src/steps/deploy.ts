import { join } from "node:path";
import { parseJsonc } from "../jsonc.ts";
import type { State } from "../state.ts";
import type { ActionRequired, Ctx, Opts, Step } from "../step.ts";
import { repoVersion } from "../version.ts";

export const SERVER_DIR = "apps/server";
const CONFIG = "wrangler.jsonc";
const DIST_INDEX = "apps/dashboard/dist/index.html";
/** The rendered config, beside wrangler.jsonc so `main` and `assets` resolve the same; gitignored, kept for inspection. */
export const setupConfig = (name: string) => `wrangler.setup-${name}.jsonc`;

/**
 * `wrangler deploy` argv, run from apps/server against the rendered config
 * (`setupConfig`). Every var is passed as `--var NAME:value`.
 * No `--domain`: wrangler (4.152, what apps/server resolves) merges `--domain`
 * into the config's own routes, which would also bind the checked-in
 * staging.open-bus.ai. The rendered config's `routes` is exactly
 * `[{ pattern: host, custom_domain: true }]` instead.
 */
export function deployArgs(
  opts: Pick<Opts, "name" | "host" | "ownerEmail">,
  access: { teamDomain: string; clientId: string },
  version: string,
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
    ...["deploy", "-c", setupConfig(opts.name), "--name", opts.name],
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
  ];
}

/** apps/server/wrangler.jsonc with `name` and `routes` set for this instance. */
export function renderConfig(text: string, name: string, host: string) {
  const cfg = parseJsonc(text) as Record<string, unknown>;
  return `${JSON.stringify(
    { ...cfg, name, routes: [{ pattern: host, custom_domain: true }] },
    null,
    2,
  )}\n`;
}

/** The host's suffixes that could be its zone, longest first (the host itself down to two labels). */
export const zoneCandidates = (host: string) => {
  const labels = host.split(".");
  return labels
    .slice(0, -1)
    .map((_, i) => labels.slice(i).join("."))
    .filter((z) => z.includes("."));
};

/**
 * The likely registrable zone, for the hint only: two labels, or three under a
 * two-letter TLD with a short second level (example.co.uk, not co.uk).
 */
export function zoneGuess(host: string): string {
  const l = host.split(".");
  const n =
    l.length >= 3 && l.at(-1)?.length === 2 && (l.at(-2)?.length ?? 9) <= 3
      ? 3
      : 2;
  return l.slice(-n).join(".");
}

type Zone = { id: string; name: string };
type Domain = { id: string; hostname: string; service: string };

/** The account's zone holding `host`, by its longest matching suffix; undefined when none. */
async function zoneOf(ctx: Ctx, state: State): Promise<Zone | undefined> {
  for (const name of zoneCandidates(ctx.opts.host)) {
    const q = `name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(state.accountId ?? "")}`;
    const hit = (await ctx.api<Zone[]>("GET", `/zones?${q}`))?.find(
      (z) => z.name === name,
    );
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Read-only checks on --host, run before anything is written (secrets and
 * deploy): its zone is on the account, it is not another Worker's custom
 * domain, and it has no DNS record setup did not create. Non-interactive
 * wrangler would otherwise steal the domain or overwrite the record.
 */
export async function hostCheck(
  state: State,
  ctx: Ctx,
): Promise<ActionRequired | undefined> {
  const { host, name } = ctx.opts;
  const zone = await zoneOf(ctx, state);
  if (!zone) {
    const guess = zoneGuess(host);
    const tried = zoneCandidates(host).filter((z) => z.length >= guess.length);
    return {
      status: "action_required",
      message: `no zone for ${host} on Cloudflare account ${state.accountId} (looked for ${tried.join(", ")}): ask the user to add their zone (likely ${guess}) at https://dash.cloudflare.com/${state.accountId}/add-site, or pick a --host under a zone they have, then rerun`,
      data: { zone: guess, candidates: tried, host },
    };
  }
  const a = `/accounts/${state.accountId ?? ""}`;
  const bound = (
    await ctx.api.all<Domain>(
      `${a}/workers/domains?hostname=${encodeURIComponent(host)}`,
    )
  ).filter((d) => d.hostname === host);
  const other = bound.find((d) => d.service !== name);
  if (other)
    return {
      status: "action_required",
      message: `${host} is already the custom domain of Worker ${other.service}; pick another --host, or remove it from ${other.service} (Workers & Pages > ${other.service} > Domains) if the user agrees, then rerun`,
      data: { host, service: other.service },
    };
  if (bound.some((d) => d.service === name)) return undefined;
  const records = await ctx.api<{ type: string; name: string }[]>(
    "GET",
    `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`,
  );
  const mine = (records ?? []).filter((r) => r.name === host);
  if (mine.length)
    return {
      status: "action_required",
      message: `${host} already has DNS records (${mine.map((r) => r.type).join(", ")}) that setup did not create; pick another --host, or delete them in the ${zone.name} DNS settings if the user agrees, then rerun`,
      data: { host, records: mine.map((r) => r.type) },
    };
  return undefined;
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
    const refused = await hostCheck(state, ctx);
    if (refused) return refused;
    const version = repoVersion(ctx);
    // As deploy-staging does: build everything, then make sure the assets dir has an index.
    const b = await ctx.deps.exec("pnpm", ["build"], {
      cwd: ctx.root,
      timeoutMs: 600_000,
    });
    if (b.code !== 0)
      throw new Error(`pnpm build failed: ${(b.stderr || b.stdout).trim()}`);
    const dist = join(ctx.root, DIST_INDEX);
    if (ctx.fs.read(dist) === null) {
      ctx.fs.write(dist, "<!doctype html><title>OpenBus</title>\n");
      ctx.notes.push(`the build left no ${DIST_INDEX}; wrote a placeholder`);
    }
    ctx.fs.write(
      join(dir, setupConfig(ctx.opts.name)),
      renderConfig(text, ctx.opts.name, ctx.opts.host),
    );
    await ctx.wrangler(
      deployArgs(
        ctx.opts,
        { teamDomain: state.teamDomain, clientId: state.accessClientId },
        version,
      ),
      { cwd: dir, timeoutMs: 600_000 },
    );
    state.deployedVersion = version;
    state.host = ctx.opts.host;
    ctx.notes.push(`deployed ${version} to ${ctx.opts.host}`);
    ctx.data = { version, host: ctx.opts.host };
    return undefined;
  },
};
