import { resolve } from "node:path";
import { daemon } from "./commands/daemon.ts";
import { doctor } from "./commands/doctor.ts";
import { install, loginStep } from "./commands/install.ts";
import { logs } from "./commands/logs.ts";
import { mcp } from "./commands/mcp.ts";
import { status } from "./commands/status.ts";
import { uninstall } from "./commands/uninstall.ts";
import { type Ctx, realCtx, say, sayErr } from "./context.ts";
import { type Command, parse } from "./index.ts";

/**
 * `open-bus <argv>`. Resolves the exit code, or undefined when the command
 * keeps running on its own (`mcp`).
 */
export async function main(
  argv: string[],
  makeCtx: (noColor: boolean) => Ctx = realCtx,
): Promise<number | undefined> {
  let cmd: Command;
  try {
    cmd = parse(argv);
  } catch (e) {
    const ctx = makeCtx(argv.includes("--no-color"));
    sayErr(ctx, ctx.copy.usage(e instanceof Error ? e.message : String(e)));
    return 2;
  }
  const ctx = makeCtx(cmd.noColor);
  if (cmd.home) ctx.home = resolve(cmd.home);
  try {
    return await dispatch(cmd, ctx);
  } catch (e) {
    sayErr(ctx, ctx.copy.failed(e instanceof Error ? e.message : String(e)));
    return 1;
  }
}

async function dispatch(cmd: Command, ctx: Ctx): Promise<number | undefined> {
  switch (cmd.cmd) {
    case "install":
      return install(
        { hub: cmd.hub, noOpen: cmd.noOpen, check: cmd.check },
        ctx,
      );
    case "login":
      say(ctx, ctx.copy.header(ctx.version), "");
      return (await loginStep(ctx, {
        hub: cmd.hub,
        noOpen: cmd.noOpen,
        force: true,
      }))
        ? 0
        : 1;
    case "daemon":
      // The daemon reads both from the environment, as the service sets them.
      if (cmd.home) process.env.OPENBUS_HOME = ctx.home;
      if (cmd.hub) process.env.OPENBUS_HUB = cmd.hub;
      return daemon(ctx);
    case "mcp":
      return mcp(cmd.harness, ctx);
    case "status":
      return status(ctx);
    case "logs":
      return logs(ctx);
    case "doctor":
      return doctor(ctx);
    case "uninstall":
      return uninstall({ purge: cmd.purge }, ctx);
    case "version":
      say(ctx, ctx.copy.header(ctx.version));
      return 0;
  }
}
