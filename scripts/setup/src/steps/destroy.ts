import { type Ctx, NeedInput, type Step } from "../step.ts";
import { PERM } from "../tokens.ts";
import { APP_NAME, askToken, tokenWhere, useToken } from "./access.ts";
import { read, savedZone, tokenAsk } from "./host.ts";

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
        savedZone(state, ctx.opts.host),
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
    let domains: { id: string; hostname: string; service: string }[];
    try {
      domains = await read(PERM.workers_scripts, () =>
        ctx.accessApi.all<{ id: string; hostname: string; service: string }>(
          `${a}/workers/domains?service=${encodeURIComponent(ctx.opts.name)}`,
        ),
      );
    } catch (e) {
      return tokenAsk(e, state, ctx, "--destroy");
    }
    // The Worker (and its domains) only when setup got as far as writing to it:
    // the access step runs only after host and the Worker-ownership check, and
    // secrets/deploy follow it. A run that stopped earlier leaves state too, but
    // a Worker named --name then is not ours to delete (I8-01).
    const ours = Boolean(state.deployedVersion || state.accessAppId);
    if (ours) {
      for (const d of domains.filter((x) => x.service === ctx.opts.name))
        await del(
          ctx.api,
          // API-provided ids are encoded: one cannot reach another path (I8-02).
          `${a}/workers/domains/${encodeURIComponent(d.id)}`,
          `custom domain ${d.hostname}`,
        );
      // force: the script binds its own Durable Object class.
      await del(
        ctx.api,
        `${a}/workers/scripts/${encodeURIComponent(ctx.opts.name)}?force=true`,
        `Worker ${ctx.opts.name}`,
      );
    } else
      ctx.notes.push(
        `setup never wrote to Worker ${ctx.opts.name} from this machine: left it in place`,
      );
    if (state.accessAppId)
      await del(
        ctx.accessApi,
        `${a}/access/apps/${encodeURIComponent(state.accessAppId)}`,
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
