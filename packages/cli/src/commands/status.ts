import { stripTerminalControls } from "@ob/ipc";
import { semverGte } from "@ob/shared";
import {
  askDaemon,
  type Ctx,
  say,
  sayErr,
  socketFolderLines,
} from "../context.ts";
import { ago, forHowLong, type HubLink } from "../copy.ts";
import { readMachine } from "../machine.ts";
import { rosters } from "./install.ts";

export const hostOf = (hub: string) => {
  try {
    return new URL(hub).host;
  } catch {
    return hub;
  }
};

/** An older daemon omits `hub_ever` and `hub_since`: not connected reads as connecting. */
const linkOf = (
  st: {
    hub: string;
    hub_ever?: boolean | undefined;
    hub_since?: number | undefined;
  },
  now: number,
): HubLink => {
  if (st.hub === "connected") return { state: "connected" };
  if (!st.hub_ever) return { state: "connecting" };
  return {
    state: "reconnecting",
    for: st.hub_since === undefined ? undefined : forHowLong(st.hub_since, now),
  };
};

/**
 * The hub's version when it is newer than the daemon's (C26h). Undefined
 * when they are equal, the hub is older, or either is not a version (an
 * older daemon, no hello_ok yet, a `dev` hub): then nothing is said.
 */
export const newerHub = (st: {
  version: string;
  hub_version?: string | undefined;
}): string | undefined =>
  st.hub_version !== undefined &&
  semverGte(st.hub_version, st.version) &&
  !semverGte(st.version, st.hub_version)
    ? st.hub_version
    : undefined;

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
  if (m.revoked) {
    say(ctx, c.hubRow(host), c.machineRow(m.label));
    sayErr(ctx, c.revoked());
    return 1;
  }
  let st: Awaited<ReturnType<Ctx["status"]>>;
  try {
    st = await askDaemon(ctx, { timeoutMs: 3000 });
  } catch {
    say(ctx, c.hubRow(host), c.machineRow(m.label));
    sayErr(ctx, socketFolderLines(ctx) ?? c.statusDaemonDown());
    return 1;
  }
  say(ctx, c.hubRow(host, linkOf(st, ctx.now())), c.machineRow(m.label));
  say(ctx, c.daemonRunning(st.pid, ctx.service.kind, ctx.service.fallback));
  const update = newerHub(st);
  if (update) say(ctx, c.updateAvailable(update, st.version));
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
