import type { State } from "../state.ts";
import type { ActionRequired, Ctx, Step } from "../step.ts";

/** The host's suffixes that could be its zone, longest first (the host itself down to two labels). */
export const zoneCandidates = (host: string) => {
  const labels = host.split(".");
  return labels
    .slice(0, -1)
    .map((_, i) => labels.slice(i).join("."))
    .filter((z) => z.includes("."));
};

/** Second-level labels that are public suffixes under a two-letter TLD (co.uk, com.au, ...). */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov"]);

/** The likely registrable zone, for the hint only: example.co.uk, not co.uk. */
export function zoneGuess(host: string): string {
  const l = host.split(".");
  const sld =
    l.length >= 3 && l.at(-1)?.length === 2 && SECOND_LEVEL.has(l.at(-2) ?? "");
  return l.slice(sld ? -3 : -2).join(".");
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
 * Read-only checks on --host: its zone is on the account, it is not another
 * Worker's custom domain, and it has no DNS record setup did not create.
 * Non-interactive wrangler would otherwise steal the domain or overwrite the record.
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

/** Runs right after prereqs and writes nothing: a bad host stops setup before access, secrets or deploy. */
export const host: Step = {
  name: "host",
  okWhenDone: "zone on the account, host free",
  async check(state, ctx) {
    if (!ctx.opts.host) {
      ctx.notes.push("no --host");
      return "todo";
    }
    const r = await hostCheck(state, ctx);
    if (!r) return "done";
    ctx.notes.push(r.message);
    return "todo";
  },
  async apply(state, ctx) {
    return hostCheck(state, ctx);
  },
};
