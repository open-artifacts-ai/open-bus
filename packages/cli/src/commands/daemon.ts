import { type Daemon, type DaemonDeps, runDaemon } from "@ob/daemon";
import { type Ctx, sayErr } from "../context.ts";

export type Signals = Pick<NodeJS.Process, "once" | "off">;

/**
 * The daemon in the foreground; the service (C9) runs this same command.
 * Resolves 0 on SIGINT or SIGTERM and 1, once, when the hub revokes this
 * machine, so a service does not loop on a dead token.
 */
export async function daemon(
  ctx: Ctx,
  run: (deps: DaemonDeps) => Promise<Daemon> = runDaemon,
  signals: Signals = process,
): Promise<number> {
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
    run({ version: ctx.version, onRevoked: () => end(1) }).then(
      (d) => {
        running = d;
        if (ended) void d.stop();
      },
      (e: unknown) => {
        sayErr(
          ctx,
          ctx.copy.failed(e instanceof Error ? e.message : String(e)),
        );
        end(1);
      },
    );
  });
}
