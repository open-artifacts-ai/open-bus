import { type Ctx, NeedInput, type Step } from "../step.ts";
import { APP_NAME, askToken, useToken } from "./access.ts";

// Cut from Open Artifacts' destroy: no D1, R2, KV, email routing or content host.
// It deletes only what setup created: the Worker's custom domain(s), the Worker
// (with its Hub Durable Object) and the Access app. The zone and every DNS
// record setup did not create are kept.

const status = (e: unknown) => (e as { status?: number }).status;
/** A 404 means already gone. */
const gone = (e: unknown) => {
  if (status(e) !== 404) throw e;
};

/** --yes-destroy=<name>, else a typed confirmation (never under --json). */
async function confirm(ctx: Ctx) {
  const { name, yesDestroy, json } = ctx.opts;
  if (yesDestroy === name) return;
  if (yesDestroy !== undefined)
    throw new Error(
      `--yes-destroy=${yesDestroy} does not match --name ${name}; nothing deleted`,
    );
  const what = `--destroy deletes Worker ${name}, its custom domain and Durable Object data, and its Access app`;
  if (json)
    throw new NeedInput(
      `${what}. Confirm with the user, then rerun with --yes-destroy=${name}`,
    );
  const typed = await ctx.deps.prompt(`${what}. Type ${name} to confirm:`);
  if (typed !== name) throw new Error("not confirmed; nothing deleted");
}

export const destroy: Step = {
  name: "destroy",
  check: async () => "todo",
  async apply(state, ctx) {
    await confirm(ctx);
    const a = `/accounts/${state.accountId ?? ""}`;
    // The Access token first: nothing is deleted unless all of it can be.
    if (state.accessAppId && !useToken(ctx))
      return askToken(
        ctx,
        state.accountId ?? "",
        `Deleting Access app ${APP_NAME(ctx.opts.name)} needs the Access token.`,
      );
    const deleted: string[] = [];
    const domains = await ctx.api.all<{
      id: string;
      hostname: string;
      service: string;
    }>(`${a}/workers/domains?service=${encodeURIComponent(ctx.opts.name)}`);
    for (const d of domains.filter((x) => x.service === ctx.opts.name)) {
      await ctx.api("DELETE", `${a}/workers/domains/${d.id}`).catch(gone);
      deleted.push(`custom domain ${d.hostname}`);
    }
    // force: the script binds its own Durable Object class.
    await ctx
      .api(
        "DELETE",
        `${a}/workers/scripts/${encodeURIComponent(ctx.opts.name)}?force=true`,
      )
      .catch(gone);
    deleted.push(`Worker ${ctx.opts.name}`);
    if (state.accessAppId) {
      await ctx
        .accessApi("DELETE", `${a}/access/apps/${state.accessAppId}`)
        .catch(gone);
      deleted.push(`Access app ${state.accessAppId}`);
    }
    ctx.notes.push(`deleted ${deleted.join(", ")}`);
    return undefined;
  },
};
