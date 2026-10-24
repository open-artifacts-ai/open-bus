import { join } from "node:path";
import { type Ctx, say, sayErr } from "../context.ts";
import { readMachine } from "../machine.ts";
import { roster } from "./install.ts";

const hostOf = (hub: string) => {
  try {
    return new URL(hub).host;
  } catch {
    return hub;
  }
};

/** This machine, its daemon and the cwd's roster. Never prints the token. */
export async function status(ctx: Ctx): Promise<number> {
  const c = ctx.copy;
  say(ctx, c.header(ctx.version), "");
  const m = readMachine(ctx.home);
  if (m.state !== "ok") {
    sayErr(ctx, c.notConnected());
    return 1;
  }
  say(ctx, c.connectedTo(m.label, hostOf(ctx.env.OPENBUS_HUB ?? m.hub)));
  let st: Awaited<ReturnType<Ctx["status"]>>;
  try {
    st = await ctx.status({
      path: join(ctx.home, "daemon.sock"),
      cwd: ctx.cwd,
      timeoutMs: 2000,
    });
  } catch {
    sayErr(ctx, c.daemonDown());
    return 1;
  }
  say(ctx, c.daemonRunningPlain(st.pid));
  say(ctx, st.hub === "connected" ? c.hubConnected() : c.hubConnecting());
  say(ctx, "", roster(ctx, st));
  return 0;
}

export { hostOf };
