import { join } from "node:path";
import {
  MIN_PROMPT_ID_VERSION,
  opencodeVersion,
  supportsPromptId,
} from "@ob/adapter-opencode";
import { type Ctx, say, tilde } from "../context.ts";
import { readMachine } from "../machine.ts";
import { checkAdapters, type Harness } from "../steps/adapters.ts";
import { hostOf } from "./status.ts";

/** Read-only evidence for a bug report. Writes nothing; never prints the token. */
export async function doctor(ctx: Ctx): Promise<number> {
  const c = ctx.copy;
  let problems = 0;
  const problem = (...lines: (string | string[])[]) => {
    problems++;
    say(ctx, ...lines);
  };
  say(ctx, c.header(ctx.version), "");

  const machinePath = tilde(ctx, join(ctx.home, "machine.json"));
  const m = readMachine(ctx.home);
  if (m.state === "missing") problem(c.notConnectedWarn());
  else if (m.state === "bad") problem(c.machineFileBad(machinePath));
  else {
    say(ctx, c.connectedTo(m.label, hostOf(ctx.env.OPENBUS_HUB ?? m.hub)));
    if (m.open) problem(c.machineFileOpen(machinePath));
  }

  const socket = join(ctx.home, "daemon.sock");
  try {
    const st = await ctx.status({ path: socket, timeoutMs: 2000 });
    say(ctx, c.daemonRunningPlain(st.pid));
    if (st.hub !== "connected") problem(c.hubConnecting());
  } catch {
    problem(c.daemonNotAnswering(tilde(ctx, socket)));
  }

  const states = checkAdapters({
    home: ctx.userHome,
    openbusHome: ctx.home,
    env: ctx.env,
    which: ctx.which,
  });
  for (const h of ["claude", "opencode", "pi"] as Harness[]) {
    const state = states[h];
    if (state === "absent") {
      say(ctx, c.harnessAbsent(h));
      continue;
    }
    let version: string | undefined;
    if (h === "opencode") {
      version = await opencodeVersion(ctx.exec);
      if (version === undefined) {
        problem(c.opencodeUnknown());
        continue;
      }
      if (!supportsPromptId(version)) {
        problem(c.opencodeTooOld(version, MIN_PROMPT_ID_VERSION));
        continue;
      }
    }
    if (state === "configured") say(ctx, c.harnessConfigured(h, version));
    else problem(c.harnessMissing(h));
  }

  say(ctx, "");
  if (problems === 0) say(ctx, c.allGood());
  say(
    ctx,
    c.footer(ctx.version, ctx.nodeVersion, ctx.platform, tilde(ctx, ctx.home)),
  );
  return problems === 0 ? 0 : 1;
}
