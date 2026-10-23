import { join } from "node:path";
import type { State } from "../state.ts";
import type { ActionRequired, Ctx, Opts, Step } from "../step.ts";
import { repoVersion } from "../version.ts";

export const SERVER_DIR = "apps/server";
const CONFIG = "wrangler.jsonc";

/**
 * `wrangler deploy` argv, run from apps/server. Every var is passed as
 * `--var NAME:value`, overriding the config's `{{…}}` placeholders.
 * Custom domain: the pinned wrangler (4.32) has `--domain`, so no temp config
 * with `routes: [{ pattern, custom_domain: true }]` is written.
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
    ...["deploy", "-c", CONFIG, "--name", opts.name, "--domain", opts.host],
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
  ];
}

/** The host's suffixes that could be its zone, longest first (the host itself down to two labels). */
export const zoneCandidates = (host: string) => {
  const labels = host.split(".");
  return labels
    .slice(0, -1)
    .map((_, i) => labels.slice(i).join("."))
    .filter((z) => z.includes("."));
};

/** The account's zone holding `host`, by its longest matching suffix; undefined when none. */
async function zoneOf(ctx: Ctx, state: State) {
  for (const name of zoneCandidates(ctx.opts.host)) {
    const q = `name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(state.accountId ?? "")}`;
    const hit = await ctx.api<{ id: string; name: string }[]>(
      "GET",
      `/zones?${q}`,
    );
    if (hit?.some((z) => z.name === name)) return name;
  }
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
    if (ctx.fs.read(join(dir, CONFIG)) === null)
      throw new Error(
        `missing ${SERVER_DIR}/${CONFIG}; is this the repo root?`,
      );
    if (!state.teamDomain || !state.accessClientId)
      throw new Error(
        "no Access app in state (teamDomain, accessClientId); rerun setup so the access step records it",
      );
    if (!(await zoneOf(ctx, state))) {
      const zone = zoneCandidates(ctx.opts.host).at(-1) ?? ctx.opts.host;
      return {
        status: "action_required",
        message: `zone ${zone} (for ${ctx.opts.host}) is not on Cloudflare account ${state.accountId}: ask the user to add ${zone} at https://dash.cloudflare.com/${state.accountId}/add-site (or pick a --host under a zone they have), then rerun`,
        data: { zone, host: ctx.opts.host },
      };
    }
    const version = repoVersion(ctx);
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
