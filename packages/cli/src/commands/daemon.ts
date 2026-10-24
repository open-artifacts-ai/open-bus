import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, type DaemonDeps, runDaemon } from "@ob/daemon";
import { type Ctx, sayErr } from "../context.ts";
import { REVOKED_EXIT } from "../steps/service.ts";

export type Signals = Pick<NodeJS.Process, "once" | "off">;

/**
 * Start failures a restart cannot fix: no or bad machine.json, a hub other
 * than the approved one, another daemon on the socket.
 */
export function lasting(e: unknown): boolean {
  if ((e as { code?: unknown })?.code === "EADDRINUSE") return true;
  const m = e instanceof Error ? e.message : String(e);
  return /not logged in|not the one this machine was approved for|readable by other users|malformed machine token|invalid hub url|refusing ws:\/\/|refusing http:\/\//.test(
    m,
  );
}

/**
 * The daemon in the foreground; the service runs this same command.
 * Resolves 0 on SIGINT or SIGTERM and 78, once, when the hub revokes this
 * machine: systemd does not restart on 78, and launchd's one restart finds
 * the revoked marker and exits 0, so no service loops on a dead token.
 * Under a service (OPENBUS_SERVICE=1, set by the unit) a lasting start
 * failure exits 0 too; in a terminal it exits 1.
 */
export async function daemon(
  ctx: Ctx,
  run: (deps: DaemonDeps) => Promise<Daemon> = runDaemon,
  signals: Signals = process,
): Promise<number> {
  if (existsSync(join(ctx.home, "revoked"))) {
    sayErr(ctx, ctx.copy.revoked());
    return 0;
  }
  return new Promise<number>((resolve) => {
    let running: Daemon | undefined;
    let ended = false;
    const end = (code: number) => {
      if (ended) return;
      ended = true;
      signals.off("SIGINT", onSignal);
      signals.off("SIGTERM", onSignal);
      void (running?.stop() ?? Promise.resolve()).finally(() => resolve(code));
    };
    const onSignal = () => end(0);
    signals.once("SIGINT", onSignal);
    signals.once("SIGTERM", onSignal);
    run({ version: ctx.version, onRevoked: () => end(REVOKED_EXIT) }).then(
      (d) => {
        running = d;
        if (ended) void d.stop();
      },
      (e: unknown) => {
        sayErr(
          ctx,
          ctx.copy.failed(e instanceof Error ? e.message : String(e)),
        );
        end(ctx.env.OPENBUS_SERVICE === "1" && lasting(e) ? 0 : 1);
      },
    );
  });
}
