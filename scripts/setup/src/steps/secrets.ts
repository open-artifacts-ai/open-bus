import { randomBytes } from "node:crypto";
import type { Ctx, Step } from "../step.ts";
import { ACCESS_SECRET } from "./access.ts";
import { hostCheck } from "./deploy.ts";

// Cut from Open Artifacts' secrets step: no CONTENT_SIGNING_KEY, no analytics token.
export const SESSION_SECRET = "SESSION_SECRET";
const REQUIRED = [ACCESS_SECRET, SESSION_SECRET];
/** The API's code for a Worker that doesn't exist yet; any other failure is an error. */
const NO_WORKER = /\[code: 10007\]/;

/** Parses wrangler JSON output from the first line starting with `[` (banners may hold brackets). */
export function jsonArray<T>(out: string, what: string): T[] {
  const i = out.search(/^\s*\[/m);
  if (i < 0) throw new Error(`\`${what}\` returned no JSON array`);
  return JSON.parse(out.slice(i)) as T[];
}

/** The Worker's secret names. A Worker that doesn't exist yet has none. */
export async function listSecrets(ctx: Ctx): Promise<string[]> {
  let out: string;
  try {
    out = await ctx.wrangler(
      ["secret", "list", "--name", ctx.opts.name, "--format", "json"],
      { timeoutMs: 120_000 },
    );
  } catch (e) {
    if (NO_WORKER.test((e as Error).message)) return [];
    throw e;
  }
  return jsonArray<{ name: string }>(out, "wrangler secret list").map(
    (s) => s.name,
  );
}

/** 36 random bytes, base64url: 48 chars. */
const random = () => randomBytes(36).toString("base64url");

/** What this run must put: a fresh client secret, and SESSION_SECRET only when the Worker lacks it. */
function payload(ctx: Ctx, have: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const fresh = ctx.secrets?.[ACCESS_SECRET];
  if (fresh) out[ACCESS_SECRET] = fresh;
  else if (!have.includes(ACCESS_SECRET))
    throw new Error(
      `${ACCESS_SECRET} is neither on the Worker nor from this run's access step; rerun setup without --check`,
    );
  // Never rotated: a new value would sign every session out.
  if (!have.includes(SESSION_SECRET)) out[SESSION_SECRET] = random();
  return out;
}

export const secrets: Step = {
  name: "secrets",
  async check(_state, ctx) {
    const have = await listSecrets(ctx);
    return REQUIRED.every((n) => have.includes(n)) &&
      !ctx.secrets?.[ACCESS_SECRET]
      ? "done"
      : "todo";
  },
  async apply(state, ctx) {
    // Nothing is written (secret bulk creates a draft Worker) for a host deploy would refuse.
    const refused = await hostCheck(state, ctx);
    if (refused) return refused;
    const put = payload(ctx, await listSecrets(ctx));
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
    if (put[ACCESS_SECRET]) delete state.clientSecretPending;
    ctx.notes.push(`set ${Object.keys(put).join(", ")}`);
    return undefined;
  },
};
