import type { State } from "../state.ts";
import { type Ctx, NeedInput, type Step } from "../step.ts";

type Account = { id: string; name: string };

const nodeMajor = (ctx: Ctx) =>
  Number((ctx.deps.nodeVersion ?? process.versions.node).split(".")[0]);

/** Accounts the wrangler login reaches; empty when not logged in. */
async function accounts(ctx: Ctx): Promise<Account[]> {
  let out: string;
  try {
    out = await ctx.wrangler(["whoami", "--json"], { timeoutMs: 180_000 });
  } catch {
    return [];
  }
  try {
    const list = (JSON.parse(out) as { accounts?: Account[] }).accounts;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Node 22+, a Cloudflare login, and exactly one account (or --account-id). */
export const prereqs: Step = {
  name: "prereqs",
  always: true,
  okWhenDone: "Node 22+, logged in to Cloudflare",
  async check(state: State, ctx: Ctx) {
    if (nodeMajor(ctx) < 22)
      throw new Error(
        `Node ${ctx.deps.nodeVersion ?? process.versions.node} is too old: OpenBus needs Node 22 or later`,
      );
    const list = await accounts(ctx);
    if (list.length === 0)
      throw new NeedInput(
        "not logged in to Cloudflare: ask the user to run `npx wrangler login` and approve in the browser, then run setup again",
      );
    const want = ctx.opts.accountId;
    if (want) {
      if (!list.some((a) => a.id === want))
        throw new NeedInput(
          `--account-id ${want} is not reachable with this login`,
          { accounts: list },
        );
      state.accountId = want;
    } else if (list.length === 1) state.accountId = list[0].id;
    else
      throw new NeedInput(
        "this login reaches several Cloudflare accounts: pass --account-id <id>",
        { accounts: list },
      );
    return "done";
  },
  async apply() {
    return undefined;
  },
};
