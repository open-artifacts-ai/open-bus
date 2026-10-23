import type { State } from "../state.ts";
import { type Ctx, NeedInput, type Step } from "../step.ts";

type Account = { id: string; name: string };

const nodeMajor = (ctx: Ctx) =>
  Number((ctx.deps.nodeVersion ?? process.versions.node).split(".")[0]);

/** Accounts the wrangler login reaches; empty when not logged in. A failed whoami (crash, timeout, no npx) throws. */
async function accounts(ctx: Ctx): Promise<Account[]> {
  let out: string;
  try {
    out = await ctx.wrangler(["whoami", "--json"], { timeoutMs: 180_000 });
  } catch (e) {
    // A logged-out wrangler may exit non-zero; anything else is a real failure.
    if (
      /not (logged in|authenticated)|wrangler login/i.test((e as Error).message)
    )
      return [];
    throw e;
  }
  // wrangler may print a banner before the JSON.
  const start = out.indexOf("{");
  let parsed: { loggedIn?: boolean; accounts?: unknown };
  try {
    parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
  } catch {
    throw new Error("could not read `wrangler whoami --json` output");
  }
  if (parsed.loggedIn === false || !Array.isArray(parsed.accounts)) return [];
  return parsed.accounts.filter(
    (a): a is Account =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as Account).id === "string" &&
      (a as Account).id !== "",
  );
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
