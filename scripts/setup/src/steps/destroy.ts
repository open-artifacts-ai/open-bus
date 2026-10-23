import { type Ctx, NeedInput, type Step } from "../step.ts";
import { APP_NAME, askToken, tokenWhere, useToken } from "./access.ts";

// Cut from Open Artifacts' destroy: no D1, R2, KV, email routing or content host.
// It deletes only what setup created: the Worker's custom domain(s), the Worker
// (with its Hub Durable Object) and the Access app. The zone and every DNS
// record setup did not create are kept.

const status = (e: unknown) => (e as { status?: number }).status;

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
    // The setup token first (it lists the custom domains and deletes the
    // Access app): nothing is deleted unless all of it can be.
    if (!useToken(ctx))
      return askToken(
        ctx,
        state.accountId ?? "",
        `Destroying ${ctx.opts.name} needs the setup token (${tokenWhere(ctx)}).`,
        state.zoneId,
      );
    const deleted: string[] = [];
    const gone: string[] = [];
    /** DELETEs `path`; a 404 lands `what` in "already gone". */
    const del = async (api: Ctx["api"], path: string, what: string) => {
      try {
        await api("DELETE", path);
        deleted.push(what);
      } catch (e) {
        if (status(e) !== 404) throw e;
        gone.push(what);
      }
    };
    // Read with the setup token; the deletes stay on the wrangler login.
    const domains = await ctx.accessApi.all<{
      id: string;
      hostname: string;
      service: string;
    }>(`${a}/workers/domains?service=${encodeURIComponent(ctx.opts.name)}`);
    for (const d of domains.filter((x) => x.service === ctx.opts.name))
      await del(
        ctx.api,
        `${a}/workers/domains/${d.id}`,
        `custom domain ${d.hostname}`,
      );
    // force: the script binds its own Durable Object class.
    await del(
      ctx.api,
      `${a}/workers/scripts/${encodeURIComponent(ctx.opts.name)}?force=true`,
      `Worker ${ctx.opts.name}`,
    );
    if (state.accessAppId)
      await del(
        ctx.accessApi,
        `${a}/access/apps/${state.accessAppId}`,
        `Access app ${state.accessAppId}`,
      );
    if (deleted.length) ctx.notes.push(`deleted ${deleted.join(", ")}`);
    if (gone.length) ctx.notes.push(`already gone: ${gone.join(", ")}`);
    if (!state.accessAppId)
      ctx.notes.push(
        `no Access app id in state: left Access app ${APP_NAME(ctx.opts.name)} in place if it exists; delete it in Zero Trust > Access > Applications`,
      );
    return undefined;
  },
};
