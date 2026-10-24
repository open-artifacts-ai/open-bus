import { join } from "node:path";
import { MIN_PROMPT_ID_VERSION, opencodeVersion } from "@ob/adapter-opencode";
import type { StatusReply } from "@ob/ipc";
import { type Ctx, say, sayErr, tilde } from "../context.ts";
import type { RosterAgent } from "../copy.ts";
import { spinner } from "../live.ts";
import { readMachine } from "../machine.ts";
import {
  checkAdapters,
  type Harness,
  installAdapters,
  readAssets,
} from "../steps/adapters.ts";
import { checkSteps, runSteps, type Step } from "../steps/step.ts";
import { LoginFailed, login } from "./login.ts";

/** Transcript state 6: four attempts, waiting 2, 4 and 8 s between them. */
export const CODE_RETRY_MS = [2000, 4000, 8000];
export const DAEMON_WAIT_MS = 10_000;
const DAEMON_POLL_MS = 250;
const ROSTER_ROWS = 20;

export type InstallOpts = {
  hub?: string;
  noOpen?: boolean;
  /** The machine label; defaults to the sanitized hostname. */
  label?: string;
};

const hostOf = (hub: string) => {
  try {
    return new URL(hub).host;
  } catch {
    return hub;
  }
};

/** The approval flow, as the transcript prints it. Shared with `open-bus login`. */
export async function loginStep(ctx: Ctx, opts: InstallOpts): Promise<boolean> {
  const c = ctx.copy;
  const machine = readMachine(ctx.home);
  if (machine.state === "ok") {
    say(ctx, c.alreadyConnected(machine.label), "");
    return true;
  }
  const hub = opts.hub ?? ctx.env.OPENBUS_HUB ?? "http://localhost:8787";
  const host = hostOf(hub);
  const tty = Boolean(ctx.stdout.isTTY);
  const live = spinner(ctx);
  let deadline = 0;
  try {
    const result = await login({
      hub,
      home: ctx.home,
      label: opts.label,
      noOpen: opts.noOpen,
      codeRetryMs: CODE_RETRY_MS,
      fetch: ctx.fetch,
      openBrowser: ctx.openBrowser,
      sleep: ctx.sleep,
      now: ctx.now,
      print: ctx.print,
      events: {
        retrying: ({ attempt, total, waitMs }) => {
          const lines = c.unreachable(host, waitMs / 1000, attempt + 1, total);
          if (tty) live.draw(lines);
          else say(ctx, lines);
        },
        code: ({ url, userCode, opened, noOpen }) => {
          live.clear();
          say(
            ctx,
            opened
              ? [c.opening(), c.ifNotOpened(url)]
              : [noOpen ? c.openThisUrl() : c.noBrowser(), c.url(url)],
            "",
            c.codeBox(userCode),
            "",
          );
          deadline = ctx.now() + 10 * 60_000;
          if (tty) live.spin(deadline);
          else say(ctx, c.waitingPlain());
        },
        poll: (ok) => live.failing(!ok),
      },
    });
    live.clear();
    say(
      ctx,
      c.approved(result.label),
      c.tokenSaved(
        tilde(ctx, join(ctx.home, "machine.json")),
        result.machineToken,
      ),
      "",
    );
    return true;
  } catch (e) {
    live.clear();
    if (e instanceof LoginFailed) {
      if (e.kind === "denied") sayErr(ctx, c.denied());
      else if (e.kind === "expired")
        sayErr(ctx, c.expired(e.detail.userCode ?? ""));
      else
        sayErr(
          ctx,
          c.unreachableFinal(
            host,
            e.detail.attempts ?? 1,
            e.detail.error ?? "",
          ),
        );
    } else sayErr(ctx, c.failed(e instanceof Error ? e.message : String(e)));
    return false;
  } finally {
    live.clear();
  }
}

async function harnessesStep(ctx: Ctx): Promise<boolean> {
  const c = ctx.copy;
  const out = await installAdapters({
    home: ctx.userHome,
    openbusHome: ctx.home,
    env: ctx.env,
    // The service and every MCP entry must name the same executable.
    openBusBin: ctx.env.OPENBUS_BIN ?? ctx.bin,
    assets: readAssets(),
    which: ctx.which,
    exec: ctx.exec,
  });
  if (out.installed.length > 0) say(ctx, c.configured(out.installed));
  else if (out.skipped.length === 0) say(ctx, c.noHarness());
  for (const s of out.skipped)
    say(ctx, await skippedLines(ctx, s.harness, s.reason));
  if (out.installed.includes("opencode"))
    say(ctx, out.opencodeRestarted ? c.restarted() : c.opencodeNotRunning());
  return true;
}

async function skippedLines(ctx: Ctx, h: Harness, reason: string) {
  if (h !== "opencode") return ctx.copy.skipped(h, reason);
  const v = await opencodeVersion(ctx.exec);
  return v === undefined
    ? ctx.copy.opencodeUnknown()
    : ctx.copy.opencodeTooOld(v, MIN_PROMPT_ID_VERSION);
}

/** Polls the daemon socket until it answers or `DAEMON_WAIT_MS` passes. */
export async function waitForDaemon(
  ctx: Ctx,
): Promise<StatusReply | undefined> {
  const start = ctx.now();
  const path = join(ctx.home, "daemon.sock");
  for (;;) {
    try {
      return await ctx.status({ path, cwd: ctx.cwd, timeoutMs: 1000 });
    } catch {}
    if (ctx.now() - start >= DAEMON_WAIT_MS) return undefined;
    await ctx.sleep(DAEMON_POLL_MS);
  }
}

async function daemonStep(ctx: Ctx): Promise<boolean> {
  const c = ctx.copy;
  await ctx.service.ensure();
  const st = await waitForDaemon(ctx);
  if (!st) {
    sayErr(ctx, c.daemonTimeout());
    return false;
  }
  say(ctx, c.daemonRunning(st.pid, ctx.service.kind), "");
  say(ctx, roster(ctx, st), "", c.statusHint());
  return true;
}

/** This machine's agents in the cwd's namespace, as the transcript's table. */
export function roster(ctx: Ctx, st: StatusReply): string[] {
  const c = ctx.copy;
  if (st.namespace === undefined) return [c.noNamespace()];
  if (st.agents.length === 0) return c.noAgents(st.namespace);
  const rows: RosterAgent[] = st.agents
    .map((a) => ({
      name: a.name,
      kind: a.kind,
      machine: st.label,
      state: a.live ? ("live" as const) : ("queued" as const),
    }))
    .sort(
      (a, b) =>
        Number(a.state === "queued") - Number(b.state === "queued") ||
        a.name.localeCompare(b.name),
    );
  const queued = rows.filter((r) => r.state === "queued").length;
  return [
    c.rosterHeader(st.namespace, rows.length - queued, queued),
    ...rows.slice(0, ROSTER_ROWS).map(c.rosterRow),
    ...(rows.length > ROSTER_ROWS
      ? [c.rosterMore(rows.length - ROSTER_ROWS)]
      : []),
    ...(queued > 0 ? c.queuedFootnote() : []),
  ];
}

export const installSteps = (opts: InstallOpts): Step<Ctx>[] => [
  {
    name: "login",
    label: "Machine approved",
    check: async (ctx) =>
      readMachine(ctx.home).state === "ok" ? "done" : "todo",
    apply: (ctx) => loginStep(ctx, opts),
  },
  {
    name: "harnesses",
    label: "Harnesses configured",
    check: async (ctx) =>
      Object.values(
        checkAdapters({
          home: ctx.userHome,
          openbusHome: ctx.home,
          env: ctx.env,
          which: ctx.which,
        }),
      ).includes("missing")
        ? "todo"
        : "done",
    apply: harnessesStep,
  },
  {
    name: "daemon",
    label: "Daemon answering",
    check: async (ctx) => {
      try {
        await ctx.status({
          path: join(ctx.home, "daemon.sock"),
          timeoutMs: 1000,
        });
        return "done";
      } catch {
        return "todo";
      }
    },
    apply: daemonStep,
  },
];

export async function install(
  opts: InstallOpts & { check?: boolean },
  ctx: Ctx,
): Promise<number> {
  const c = ctx.copy;
  say(ctx, c.header(ctx.version), "");
  const steps = installSteps(opts);
  if (opts.check) {
    const results = await checkSteps(steps, ctx);
    for (const { step, state } of results) {
      say(ctx, c.checkLine(step.label, state === "done"));
      if (state === "todo") say(ctx, c.checkNext());
    }
    return results.every((r) => r.state === "done") ? 0 : 1;
  }
  const ok = await runSteps(steps, ctx, {
    path: join(ctx.home, "install.json"),
    now: ctx.now,
  });
  return ok ? 0 : 1;
}
