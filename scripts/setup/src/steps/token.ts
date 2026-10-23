import type { State } from "../state.ts";
import { type Ctx, NeedInput, type Step } from "../step.ts";
import { askToken, tokenWhere, useToken } from "./access.ts";
import { savedZone, zoneOf } from "./host.ts";

/**
 * The host's zone id for the token link: saved, else a best-effort lookup with
 * the wrangler login (the setup token doesn't exist yet). Undefined on any failure.
 */
async function knownZone(ctx: Ctx, state: State) {
  if (!ctx.opts.host) return undefined;
  const saved = savedZone(state, ctx.opts.host);
  if (saved) return saved;
  try {
    return (await zoneOf(ctx.api, ctx.opts.host, state.accountId))?.id;
  } catch {
    return undefined;
  }
}

/**
 * Loads the setup token before anything reads with it or writes; asks for it,
 * once, when absent. Beyond Access edit, it carries Zone: Read and DNS: Read
 * (the host check; `wrangler login` cannot read DNS records) and Workers
 * Scripts: Read (`GET workers/domains`, in host and destroy).
 */
export const token: Step = {
  name: "token",
  okWhenDone: "setup token found",
  async check(_state, ctx) {
    try {
      if (useToken(ctx)) return "done";
    } catch (e) {
      // An unreadable token file: --check reports it, never prompts.
      if (!(e instanceof NeedInput)) throw e;
      ctx.notes.push(e.message);
      return "todo";
    }
    ctx.notes.push(`no setup token (${tokenWhere(ctx)})`);
    return "todo";
  },
  async apply(state, ctx) {
    if (useToken(ctx)) return undefined;
    return askToken(
      ctx,
      state.accountId ?? "",
      "Setup needs one Cloudflare API token: `wrangler login` cannot edit Access or read DNS records.",
      await knownZone(ctx, state),
    );
  },
};
