import type { State } from "../state.ts";
import type { Ctx, Step } from "../step.ts";
import { askToken, tokenWhere, useToken } from "./access.ts";
import { zoneOf } from "./host.ts";

/**
 * The host's zone id for the token link: saved, else a best-effort lookup with
 * the wrangler login (the setup token doesn't exist yet). Undefined on any failure.
 */
async function knownZone(ctx: Ctx, state: State) {
  if (state.zoneId) return state.zoneId;
  if (!ctx.opts.host) return undefined;
  try {
    return (await zoneOf(ctx.api, ctx.opts.host, state.accountId))?.id;
  } catch {
    return undefined;
  }
}

/** Loads the setup token before anything reads with it or writes; asks for it, once, when absent. */
export const token: Step = {
  name: "token",
  okWhenDone: "setup token found",
  async check(_state, ctx) {
    if (useToken(ctx)) return "done";
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
