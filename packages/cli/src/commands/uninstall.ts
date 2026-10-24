import { join } from "node:path";
import { type Ctx, say, sayErr, tilde } from "../context.ts";
import { readAssets, uninstallAdapters } from "../steps/adapters.ts";
import { purge } from "../steps/purge.ts";

export async function uninstall(
  opts: { purge: boolean },
  ctx: Ctx,
): Promise<number> {
  const c = ctx.copy;
  say(ctx, c.header(ctx.version), "");
  const r = await uninstallAdapters({
    home: ctx.userHome,
    openbusHome: ctx.home,
    env: ctx.env,
    openBusBin: ctx.env.OPENBUS_BIN ?? ctx.bin,
    assets: readAssets(),
    which: ctx.which,
    exec: ctx.exec,
  });
  if (r.removed.length > 0) say(ctx, c.removedFrom(r.removed));
  else if (r.skipped.length === 0) say(ctx, c.nothingToRemove());
  for (const s of r.skipped) say(ctx, c.couldNotRemove(s.harness, s.reason));
  if (ctx.service.kind) {
    await ctx.service.remove();
    say(ctx, c.serviceRemoved());
  }
  const home = tilde(ctx, ctx.home);
  if (!opts.purge) {
    say(ctx, c.kept(home));
    return r.skipped.length > 0 ? 1 : 0;
  }
  try {
    const st = await ctx.status({
      path: join(ctx.home, "daemon.sock"),
      timeoutMs: 1000,
    });
    // Its socket and stores would come back the moment we removed them.
    sayErr(ctx, c.purgeDaemonRunning(st.pid));
    return 1;
  } catch {}
  const out = purge(ctx.home);
  say(ctx, c.purged(home));
  if (out.leftDir) say(ctx, c.purgeLeftDir(home));
  return r.skipped.length > 0 ? 1 : 0;
}
