import { join } from "node:path";
import { stripTerminalControls } from "@ob/ipc";
import { type Ctx, say, sayErr } from "../context.ts";
import { ago } from "../copy.ts";
import { readMachine } from "../machine.ts";
import { rosters } from "./install.ts";

export const hostOf = (hub: string) => {
  try {
    return new URL(hub).host;
  } catch {
    return hub;
  }
};

/**
 * Transcript state 7. Read-only; never prints the token. Exit 0 only when
 * the daemon reports an open hub link.
 */
export async function status(ctx: Ctx): Promise<number> {
  const c = ctx.copy;
  say(ctx, c.header(ctx.version), "");
  const m = readMachine(ctx.home);
  if (m.state !== "ok") {
    sayErr(ctx, c.notRegistered());
    return 1;
  }
  // machine.json's hub: OPENBUS_HUB only picks one before login.
  const host = hostOf(m.hub);
  say(ctx, c.hubRow(host), c.machineRow(m.label));
  if (m.revoked) {
    sayErr(ctx, c.revoked());
    return 1;
  }
  let st: Awaited<ReturnType<Ctx["status"]>>;
  try {
    st = await ctx.status({
      path: join(ctx.home, "daemon.sock"),
      timeoutMs: 3000,
    });
  } catch {
    sayErr(ctx, c.statusDaemonDown());
    return 1;
  }
  say(ctx, c.daemonRunning(st.pid, ctx.service.kind, ctx.service.fallback));
  if (st.hub !== "connected") {
    // Without the hub, no row's state can be known.
    sayErr(ctx, c.hubNotReachable(host, st.hub_error, "status"));
    return 1;
  }
  if (st.namespaces.length > 0) say(ctx, "", rosters(ctx, st.namespaces));
  const late = [...(st.late ?? [])].sort((a, b) => b.at - a.at);
  if (late.length > 0)
    say(ctx, "", [
      c.lateHeader(late.length),
      ...late.flatMap((l) => [
        c.lateRow(l.from, l.to, ago(l.at, ctx.now())),
        ...(l.excerpt ? [c.lateQuote(stripTerminalControls(l.excerpt))] : []),
      ]),
    ]);
  return 0;
}
