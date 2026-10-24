import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  daemonSocketPath,
  shortSocketDir,
  unsafeSocketDir,
} from "@ob/adapter-claude-code";
import {
  MIN_PROMPT_ID_VERSION,
  opencodeVersion,
  supportsPromptId,
} from "@ob/adapter-opencode";
import { type Ctx, say, sayErr, tilde } from "../context.ts";
import { readMachine } from "../machine.ts";
import { checkAdapters, type Harness } from "../steps/adapters.ts";
import { errorTail } from "./login.ts";
import { hostOf } from "./status.ts";

const MIN_NODE = 22;
const HEALTHZ_TIMEOUT_MS = 10_000;

/** `/healthz`: undefined when it answered 2xx, else the transcript's muted tail. */
async function healthz(ctx: Ctx, hub: string): Promise<string | undefined> {
  try {
    const res = await ctx.fetch(`${hub.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS),
    });
    return res.ok ? undefined : `HTTP ${res.status}`;
  } catch (e) {
    return errorTail(e);
  }
}

/** isolatePeerMachines from Claude's settings; undefined when there is no settings file. */
function claudeIsolates(path: string): boolean | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return (
      (JSON.parse(text) as { isolatePeerMachines?: unknown })
        .isolatePeerMachines === true
    );
  } catch {
    return undefined;
  }
}

/**
 * Transcript state 8. Read-only: it changes nothing, execs only
 * `opencode --version`, and shows a token only as `ob_machine_…7f3a`.
 */
export async function doctor(ctx: Ctx): Promise<number> {
  const c = ctx.copy;
  const n = { failed: 0, warnings: 0, passed: 0 };
  const pass = (line: string) => {
    n.passed++;
    say(ctx, line);
  };
  const warn = (lines: string[]) => {
    n.warnings++;
    say(ctx, lines);
  };
  const fail = (lines: string[]) => {
    n.failed++;
    sayErr(ctx, lines);
  };
  say(ctx, c.header(ctx.version), "");

  const node = ctx.nodeVersion.replace(/^v/, "");
  if (Number(node.split(".")[0]) >= MIN_NODE) pass(c.nodeOk(node));
  else fail(c.nodeOld(node));

  const machineFile = tilde(ctx, join(ctx.home, "machine.json"));
  const m = readMachine(ctx.home);
  if (m.state !== "ok") fail(c.noCredentials(machineFile));
  else if (m.revoked) fail(c.revokedCheck());
  else pass(c.credentials(machineFile, m.token));

  try {
    const st = await ctx.status({
      path: daemonSocketPath(ctx.home),
      timeoutMs: 3000,
    });
    const lines = c.daemonRunning(
      st.pid,
      ctx.service.kind,
      ctx.service.fallback,
    );
    if (ctx.service.kind) pass(lines[0] as string);
    else warn(lines);
  } catch {
    const dir = shortSocketDir(ctx.home);
    const why =
      dirname(daemonSocketPath(ctx.home)) === dir ? unsafeSocketDir(dir) : null;
    fail(
      why ? c.socketFolderUnsafe(tilde(ctx, dir), why) : c.daemonNotRunning(),
    );
  }
  for (const p of ctx.service.problems?.() ?? [])
    if (p.kind === "node-missing") fail(c.serviceNodeMissing(p.node));
    else warn(c.lingerOff());

  // machine.json's hub; OPENBUS_HUB only matters before login.
  const hub = m.state === "ok" ? m.hub : ctx.env.OPENBUS_HUB;
  if (hub !== undefined) {
    const error = await healthz(ctx, hub);
    if (error === undefined) pass(c.hubReachable(hostOf(hub)));
    else fail(c.hubNotReachable(hostOf(hub), error, "doctor"));
  }

  const wiring = checkAdapters({
    home: ctx.userHome,
    openbusHome: ctx.home,
    env: ctx.env,
    which: ctx.which,
  });
  for (const h of ["claude", "opencode", "pi"] as Harness[]) {
    if (wiring[h] === "absent") continue;
    let version: string | undefined;
    if (h === "opencode") {
      // Checked before wiring: an OpenCode install skipped is not wired.
      version = await opencodeVersion(ctx.exec);
      if (version === undefined) {
        warn(c.opencodeUnknown());
        continue;
      }
      if (!supportsPromptId(version)) {
        warn(c.opencodeTooOld(version, MIN_PROMPT_ID_VERSION));
        continue;
      }
    }
    if (wiring[h] === "configured") pass(c.wired(h, version));
    else fail(c.notWired(h));
    if (h === "claude") {
      const settings = join(
        ctx.env.CLAUDE_CONFIG_DIR ?? join(ctx.userHome, ".claude"),
        "settings.json",
      );
      const isolates = claudeIsolates(settings);
      if (isolates === false) pass(c.claudeAccepts());
      if (isolates === true) warn(c.claudeIsolates(tilde(ctx, settings)));
    }
  }

  say(ctx, "", c.summary(n.failed, n.warnings, n.passed));
  return n.failed > 0 ? 1 : 0;
}
