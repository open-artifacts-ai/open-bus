import type { Api } from "../cf.ts";
import type { State } from "../state.ts";
import {
  type ActionRequired,
  type Ctx,
  NeedInput,
  type Step,
} from "../step.ts";
import { PERM } from "../tokens.ts";
import { ACCESS_SECRET, askToken, tokenWhere, useToken } from "./access.ts";
import { listSecrets, SESSION_SECRET } from "./secrets.ts";

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

/** The saved zone id, only while the host is inside the saved zone. */
export const savedZone = (state: State, host: string) =>
  state.zoneId &&
  state.zoneName &&
  (host === state.zoneName || host.endsWith(`.${state.zoneName}`))
    ? state.zoneId
    : undefined;

/** A setup-token read refused: 403 (lacks `perm`) or 401 (`perm` undefined: invalid or revoked). */
class TokenRefused extends Error {
  perm?: string;
  constructor(perm?: string) {
    super(perm ?? "invalid token");
    this.perm = perm;
  }
}
const status = (e: unknown) => (e as { status?: number }).status;
/** Runs a setup-token read; a 403 or 401 becomes TokenRefused. */
export const read = async <T>(
  perm: string,
  f: () => Promise<T>,
): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    if (status(e) === 403) throw new TokenRefused(perm);
    if (status(e) === 401) throw new TokenRefused();
    throw e;
  }
};

/** A refused setup-token read as an ask for a better token; anything else rethrown. */
export function tokenAsk(
  e: unknown,
  state: State,
  ctx: Ctx,
  what: string,
): ActionRequired {
  if (!(e instanceof TokenRefused)) throw e;
  return askToken(
    ctx,
    state.accountId ?? "",
    e.perm
      ? `The setup token cannot read what ${what} needs (403): it lacks ${e.perm}. Edit the token to add it (or create a new one with the link), save it again, then rerun.`
      : `The setup token is invalid or revoked (401). Create a new one with the link, save it again, then rerun.`,
    savedZone(state, ctx.opts.host),
  );
}

/**
 * Read-only checks on --host, with the setup token (the wrangler login cannot
 * read DNS records): its zone is on the account, it is not another Worker's
 * custom domain, and it has no DNS record setup did not create.
 * Non-interactive wrangler would otherwise steal the domain or overwrite the record.
 * A 403 asks for the missing permission on the setup token.
 */
export async function hostFree(
  state: State,
  ctx: Ctx,
): Promise<ActionRequired | undefined> {
  const accountId = state.accountId ?? "";
  if (!useToken(ctx))
    return askToken(
      ctx,
      accountId,
      `Checking ${ctx.opts.host} needs the setup token (${tokenWhere(ctx)}).`,
      savedZone(state, ctx.opts.host),
    );
  try {
    return await checks(state, ctx, ctx.accessApi);
  } catch (e) {
    return tokenAsk(e, state, ctx, "the host check");
  }
}

async function checks(
  state: State,
  ctx: Ctx,
  api: Api,
): Promise<ActionRequired | undefined> {
  const { host, name } = ctx.opts;
  let zone = await read(PERM.zone, () => zoneOf(api, host, state.accountId));
  if (!zone) {
    // A token without Zone: Read on the zone gets 200 and an empty list, not
    // 403: if the wrangler login sees the zone, the token lacks the permission.
    zone = await zoneOf(ctx.api, host, state.accountId).catch(() => undefined);
    if (zone) {
      state.zoneId = zone.id;
      state.zoneName = zone.name;
      throw new TokenRefused(`${PERM.zone} on ${zone.name}`);
    }
    const guess = zoneGuess(host);
    const tried = zoneCandidates(host).filter((z) => z.length >= guess.length);
    return {
      status: "action_required",
      message: `no zone for ${host} on Cloudflare account ${state.accountId} (looked for ${tried.join(", ")}): ask the user to add their zone (likely ${guess}) at https://dash.cloudflare.com/${state.accountId}/add-site, or pick a --host under a zone they have, then rerun`,
      data: { zone: guess, candidates: tried, host },
    };
  }
  state.zoneId = zone.id;
  state.zoneName = zone.name;
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

/**
 * The Worker named --name, before anything writes to it (I8-03, I8-07):
 * - a first install (no record of access or a deploy in state) refuses a Worker
 *   that already holds secrets and none of OpenBus's: someone else's Worker;
 * - --upgrade refuses when there is no OpenBus Worker (no SESSION_SECRET) to upgrade.
 * Identified by secret names, which `wrangler secret list` reads with the login.
 */
async function workerGuard(
  state: State,
  ctx: Ctx,
): Promise<ActionRequired | undefined> {
  const fresh = !state.accessAppId && !state.deployedVersion;
  if (!fresh && !ctx.opts.upgrade) return undefined;
  const have = await listSecrets(ctx);
  const name = ctx.opts.name;
  if (ctx.opts.upgrade && !have.includes(SESSION_SECRET))
    return {
      status: "action_required",
      message: `--upgrade found no OpenBus Worker ${name} on the account (no ${SESSION_SECRET}); check --name, or drop --upgrade to install a new instance`,
      data: { name },
    };
  if (
    fresh &&
    have.length > 0 &&
    !have.includes(SESSION_SECRET) &&
    !have.includes(ACCESS_SECRET)
  )
    return {
      status: "action_required",
      message: `a Worker named ${name} already exists on the account and is not an OpenBus install (its secrets are not OpenBus's); pick another --name, or delete that Worker if the user agrees, then rerun`,
      data: { name },
    };
  return undefined;
}

const hostCheck = async (state: State, ctx: Ctx) =>
  (await hostFree(state, ctx)) ?? (await workerGuard(state, ctx));

/** Runs right after prereqs and writes nothing: a bad host stops setup before access, secrets or deploy. */
export const host: Step = {
  name: "host",
  okWhenDone: "zone on the account, host free",
  async check(state, ctx) {
    if (!ctx.opts.host) {
      ctx.notes.push("no --host");
      return "todo";
    }
    let r: ActionRequired | undefined;
    try {
      r = await hostCheck(state, ctx);
    } catch (e) {
      // An unreadable token file: drift to report, never a prompt.
      if (!(e instanceof NeedInput)) throw e;
      ctx.notes.push(e.message);
      return "todo";
    }
    if (!r) return "done";
    ctx.notes.push(r.message);
    return "todo";
  },
  async apply(state, ctx) {
    return hostCheck(state, ctx);
  },
};
