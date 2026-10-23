import type { Api } from "../cf.ts";
import type { State } from "../state.ts";
import type { ActionRequired, Ctx, Step } from "../step.ts";
import { PERM } from "../tokens.ts";
import { askToken, tokenWhere, useToken } from "./access.ts";

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
export async function zoneOf(
  api: Api,
  host: string,
  accountId: string | undefined,
): Promise<Zone | undefined> {
  for (const name of zoneCandidates(host)) {
    const q = `name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(accountId ?? "")}`;
    const hit = (await api<Zone[]>("GET", `/zones?${q}`))?.find(
      (z) => z.name === name,
    );
    if (hit) return hit;
  }
  return undefined;
}

/** A 403 on one of host's reads: the setup token lacks `perm`. */
class Forbidden extends Error {
  perm: string;
  constructor(perm: string) {
    super(perm);
    this.perm = perm;
  }
}
const status = (e: unknown) => (e as { status?: number }).status;
/** Runs a read; a 403 becomes Forbidden(perm). */
const read = async <T>(perm: string, f: () => Promise<T>): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    if (status(e) === 403) throw new Forbidden(perm);
    throw e;
  }
};

/**
 * Read-only checks on --host, with the setup token (the wrangler login cannot
 * read DNS records): its zone is on the account, it is not another Worker's
 * custom domain, and it has no DNS record setup did not create.
 * Non-interactive wrangler would otherwise steal the domain or overwrite the record.
 * A 403 asks for the missing permission on the setup token.
 */
export async function hostCheck(
  state: State,
  ctx: Ctx,
): Promise<ActionRequired | undefined> {
  const accountId = state.accountId ?? "";
  if (!useToken(ctx))
    return askToken(
      ctx,
      accountId,
      `Checking ${ctx.opts.host} needs the setup token (${tokenWhere(ctx)}).`,
      state.zoneId,
    );
  try {
    return await checks(state, ctx, ctx.accessApi);
  } catch (e) {
    if (!(e instanceof Forbidden)) throw e;
    return askToken(
      ctx,
      accountId,
      `The setup token cannot read what the host check needs (403): it lacks ${e.perm}. Edit the token to add it (or create a new one with the link), save it again, then rerun.`,
      state.zoneId,
    );
  }
}

async function checks(
  state: State,
  ctx: Ctx,
  api: Api,
): Promise<ActionRequired | undefined> {
  const { host, name } = ctx.opts;
  const zone = await read(PERM.zone, () => zoneOf(api, host, state.accountId));
  if (!zone) {
    const guess = zoneGuess(host);
    const tried = zoneCandidates(host).filter((z) => z.length >= guess.length);
    return {
      status: "action_required",
      message: `no zone for ${host} on Cloudflare account ${state.accountId} (looked for ${tried.join(", ")}): ask the user to add their zone (likely ${guess}) at https://dash.cloudflare.com/${state.accountId}/add-site, or pick a --host under a zone they have, then rerun`,
      data: { zone: guess, candidates: tried, host },
    };
  }
  state.zoneId = zone.id;
  const a = `/accounts/${state.accountId ?? ""}`;
  const bound = (
    await read(PERM.workers_scripts, () =>
      api.all<Domain>(
        `${a}/workers/domains?hostname=${encodeURIComponent(host)}`,
      ),
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
  const records = await read(PERM.dns, () =>
    api<{ type: string; name: string }[]>(
      "GET",
      `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`,
    ),
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
