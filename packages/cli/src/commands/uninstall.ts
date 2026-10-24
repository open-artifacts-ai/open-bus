import { join } from "node:path";
import { type Ctx, say, sayErr, tilde } from "../context.ts";
import { readMachine } from "../machine.ts";
import { readAssets, uninstallAdapters } from "../steps/adapters.ts";
import { purge } from "../steps/purge.ts";
import { hostOf } from "./status.ts";

/** Transcript states 9 and 10. Exit 0. */
export async function uninstall(
  opts: { purge: boolean },
  ctx: Ctx,
): Promise<number> {
  const c = ctx.copy;
  say(ctx, c.header(ctx.version), "");
  // Read before anything is deleted: the closing lines name them.
  const machine = readMachine(ctx.home);

  const kind = ctx.service.kind;
  say(
    ctx,
    (await ctx.service.remove()) && kind
      ? c.serviceRemoved(kind)
      : c.noService(),
  );

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
  if (r.folderOnly.includes("opencode")) say(ctx, c.removedPluginFolder());
  if (r.removed.length + r.folderOnly.length === 0) say(ctx, c.noneWired());
  for (const s of r.skipped) say(ctx, c.couldNotRemove(s.harness, s.reason));
  if ([...r.removed, ...r.folderOnly].includes("opencode"))
    say(
      ctx,
      r.opencodeRestarted ? c.restartedUnload() : c.opencodeNotRunningUnload(),
    );

  if (!opts.purge) {
    say(ctx, "", c.kept(tilde(ctx, join(ctx.home, "machine.json"))));
    return 0;
  }
  const home = tilde(ctx, ctx.home);
  try {
    await ctx.status({ path: join(ctx.home, "daemon.sock"), timeoutMs: 1000 });
    // Its socket and stores would come back the moment we removed them.
    sayErr(ctx, c.purgeDaemonRunning(home));
    return 1;
  } catch {}
  const out = purge(ctx.home, {
    isDefault: ctx.home === join(ctx.userHome, ".openbus"),
  });
  if ("refused" in out) {
    sayErr(ctx, c.purgeRefused(home));
    return 1;
  }
  say(ctx, out.leftDir ? c.purgeLeftDir(home) : c.deleted(home));
  if (machine.state === "ok")
    say(
      ctx,
      "",
      c.stillListed(machine.label, hostOf(ctx.env.OPENBUS_HUB ?? machine.hub)),
    );
  return 0;
}
