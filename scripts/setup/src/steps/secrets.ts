import { randomBytes } from "node:crypto";
import {
  CARD_KEY,
  CARD_KEY_PREV,
  CARD_SALT,
  currentOf,
  generateCardKey,
  kidTime,
  newSalt,
  ROTATE_MIN_MS,
} from "../card-key.ts";
import type { Ctx, Step } from "../step.ts";
import { ACCESS_SECRET } from "./access.ts";

// Cut from Open Artifacts' secrets step: no CONTENT_SIGNING_KEY, no analytics token.
export const SESSION_SECRET = "SESSION_SECRET";
const REQUIRED = [ACCESS_SECRET, SESSION_SECRET];
/** Added to a Worker that lacks them (installs and CI upgrades alike); never replaced but by --rotate-card-key. */
const CARD = [CARD_KEY, CARD_SALT];
/**
 * A Worker that doesn't exist yet: the API's [code: 10007], or wrangler 4's
 * `Worker "<name>" not found.` (no code; seen on the first staging deploy).
 * Any other failure is an error.
 */
const noWorker = (message: string, name: string) =>
  /\[code: 10007\]/.test(message) ||
  message.includes(`Worker "${name}" not found`);

/** Parses wrangler JSON output from the first line starting with `[` (banners may hold brackets). */
export function jsonArray<T>(out: string, what: string): T[] {
  const i = out.search(/^\s*\[/m);
  if (i < 0) throw new Error(`\`${what}\` returned no JSON array`);
  return JSON.parse(out.slice(i)) as T[];
}

/** The Worker's secret names. A Worker that doesn't exist yet has none. */
/** The Worker's secret names, or null when there is no Worker named --name. */
export async function workerSecrets(ctx: Ctx): Promise<string[] | null> {
  let out: string;
  try {
    out = await ctx.wrangler(
      ["secret", "list", "--name", ctx.opts.name, "--format", "json"],
      { timeoutMs: 120_000 },
    );
  } catch (e) {
    if (noWorker((e as Error).message, ctx.opts.name)) return null;
    throw e;
  }
  return jsonArray<{ name: string }>(out, "wrangler secret list").map(
    (s) => s.name,
  );
}

export const listSecrets = async (ctx: Ctx): Promise<string[]> =>
  (await workerSecrets(ctx)) ?? [];

/** 36 random bytes, base64url: 48 chars. */
const random = () => randomBytes(36).toString("base64url");

/** What this run must put: a fresh client secret, and SESSION_SECRET and the card secrets only when the Worker lacks them. */
async function payload(
  ctx: Ctx,
  have: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const fresh = ctx.secrets?.[ACCESS_SECRET];
  if (fresh) out[ACCESS_SECRET] = fresh;
  else if (!have.includes(ACCESS_SECRET))
    throw new Error(
      `${ACCESS_SECRET} is neither on the Worker nor from this run's access step; rerun setup without --check`,
    );
  // Never rotated: a new value would sign every session out.
  if (!have.includes(SESSION_SECRET)) out[SESSION_SECRET] = random();
  const now = (ctx.deps.now ?? Date.now)();
  if (!have.includes(CARD_KEY))
    out[CARD_KEY] = JSON.stringify(await generateCardKey(now));
  // Never rotated: it is the owner's permanent id in every linked app.
  if (!have.includes(CARD_SALT)) out[CARD_SALT] = newSalt();
  return out;
}

const FETCH_TIMEOUT_MS = 10_000;
async function hostJson(ctx: Ctx, path: string): Promise<unknown> {
  const url = `https://${ctx.opts.host}${path}`;
  const res = await ctx.deps.fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/**
 * --rotate-card-key: a new CARD_SIGNING_KEY, and the current key's public half
 * as CARD_SIGNING_KEY_PREV. wrangler can't read a secret back, so the current
 * key comes from the live JWKS; without it nothing changes. A bus carrying
 * the shared test key answers 503 there, so its key is replaced and not kept.
 */
async function rotation(ctx: Ctx): Promise<Record<string, string>> {
  const now = (ctx.deps.now ?? Date.now)();
  const health = (await hostJson(ctx, "/healthz").catch(() => undefined)) as
    | { problem?: unknown }
    | undefined;
  if (health?.problem === "test_card_key") {
    const next = await generateCardKey(now);
    ctx.notes.push(
      `replaced the test card key with ${next.kid}; the test key is public, so it is not kept as previous`,
    );
    return { [CARD_KEY]: JSON.stringify(next) };
  }
  let jwks: unknown;
  try {
    jwks = await hostJson(ctx, "/.well-known/jwks.json");
  } catch (e) {
    throw new Error(
      `could not read the current card key (${(e as Error).message}); nothing changed`,
    );
  }
  const cur = currentOf(jwks);
  if (!cur)
    throw new Error(
      `https://${ctx.opts.host}/.well-known/jwks.json lists no card key; nothing changed`,
    );
  const since = now - (kidTime(cur.kid) ?? 0);
  if (since < ROTATE_MIN_MS && !ctx.opts.force)
    throw new Error(
      `the card key ${cur.kid} is under 24 hours old; rotate after ${new Date(now - since + ROTATE_MIN_MS).toISOString()}, or pass --force (cards signed with ${CARD_KEY_PREV} stop verifying)`,
    );
  const next = await generateCardKey(now);
  ctx.notes.push(
    `rotated the card key ${cur.kid} to ${next.kid}; ${cur.kid} stays published as previous`,
  );
  return {
    [CARD_KEY]: JSON.stringify(next),
    [CARD_KEY_PREV]: JSON.stringify(cur),
  };
}

export const secrets: Step = {
  name: "secrets",
  async check(_state, ctx) {
    if (ctx.opts.rotateCardKey) return "todo";
    const have = await listSecrets(ctx);
    const base =
      REQUIRED.every((n) => have.includes(n)) && !ctx.secrets?.[ACCESS_SECRET];
    const card = CARD.filter((n) => !have.includes(n));
    if (base && !card.length) return "done";
    // An upgrade adds these without touching the rest: prod-setup.sh's
    // preflight lets exactly this todo through.
    if (base && ctx.opts.check) ctx.notes.push(`adds ${card.join(", ")}`);
    return "todo";
  },
  async apply(state, ctx) {
    const have = await listSecrets(ctx);
    const put = await payload(ctx, have);
    if (ctx.opts.rotateCardKey) {
      if (have.includes(CARD_KEY)) Object.assign(put, await rotation(ctx));
      else ctx.notes.push(`no ${CARD_KEY} to rotate; generated one`);
    }
    if (!Object.keys(put).length) {
      ctx.skipped = true;
      return undefined;
    }
    // Scrubbed from every reported line from here on.
    ctx.secrets = { ...ctx.secrets, ...put };
    // JSON on stdin, never argv. On a Worker that doesn't exist yet, wrangler creates a draft.
    try {
      await ctx.wrangler(["secret", "bulk", "--name", ctx.opts.name], {
        input: JSON.stringify(put),
        sensitive: true,
        timeoutMs: 120_000,
      });
    } catch (e) {
      let msg = (e as Error).message;
      for (const v of Object.values(put))
        msg = msg
          .replaceAll(v, "[redacted]")
          .replaceAll(JSON.stringify(v).slice(1, -1), "[redacted]");
      throw new Error(`secret bulk failed: ${msg}`);
    }
    state.workerWritten = true;
    if (put[ACCESS_SECRET]) delete state.clientSecretPending;
    ctx.notes.push(`set ${Object.keys(put).join(", ")}`);
    return undefined;
  },
};
