import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import {
  messageHeader,
  neutralizeBody,
  oversizedText,
  stripTerminalControls,
} from "@ob/ipc";
import type { AgentRecord } from "../agents.ts";
import type { DeliverOutcome, Mail } from "../deliver.ts";

/** How long `codex queue` may run; it writes one sqlite row. */
export const CODEX_QUEUE_TIMEOUT_MS = 10_000;
/**
 * The most text one `codex queue` carries, in UTF-8 bytes. Inline bodies are
 * at most 32 KB, so only a bug reaches it; over it, the fetch notice goes.
 */
export const CODEX_TEXT_CAP = 64 * 1024;

/** The binary C26e's installer pins: `{"bin": "/abs/path/codex"}` under the OpenBus home. */
export const codexBinFile = (openbusHome: string): string =>
  join(openbusHome, "codex.json");

/** The Codex desktop app, which bundles its own `codex`. */
export const CODEX_APP = "/Applications/ChatGPT.app";
const CODEX_APP_ID = "com.openai.codex";

const executable = (p: string): boolean => {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Where the binary came from: doctor (C26e) names it. */
export type CodexBin = {
  path: string;
  from: "config" | "path" | "app";
};

/**
 * The user's own `codex`, in order: the path the installer pinned, `codex` on
 * the daemon's PATH, then the desktop app's bundled one (only when the bundle
 * is Codex's). Undefined when there is none.
 */
export function resolveCodexBin(o: {
  configFile: string;
  path?: string;
  app?: string;
}): CodexBin | undefined {
  try {
    const raw = JSON.parse(readFileSync(o.configFile, "utf8")) as {
      bin?: unknown;
    };
    if (
      typeof raw.bin === "string" &&
      isAbsolute(raw.bin) &&
      executable(raw.bin)
    )
      return { path: raw.bin, from: "config" };
  } catch {}
  for (const dir of (o.path ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const p = join(dir, "codex");
    if (executable(p)) return { path: p, from: "path" };
  }
  const app = o.app ?? CODEX_APP;
  try {
    // An XML plist; a binary one is not read, so that bundle is not used.
    const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
    const id =
      /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(
        plist,
      )?.[1];
    const p = join(app, "Contents", "Resources", "codex");
    if (id === CODEX_APP_ID && executable(p)) return { path: p, from: "app" };
  } catch {}
  return undefined;
}

/** `codex` options that take a value: their value is not the subcommand. */
const VALUE_OPTS = new Set([
  "-c",
  "--config",
  "-p",
  "--profile",
  "-m",
  "--model",
  "-C",
  "--cd",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "-i",
  "--image",
  "--enable",
  "--disable",
  "--remote",
  "--remote-auth-token-env",
  "--local-provider",
  "--add-dir",
]);

/**
 * Whether a process with these arguments (after argv[0]) wakes a thread on
 * `codex queue`: every host but `codex exec`, which is one-shot, so a queued
 * message waits for the next resume (docs/probes/codex.md §3).
 */
export function hostWakes(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") return true;
    if (a.startsWith("-")) {
      if (VALUE_OPTS.has(a)) i++;
      continue;
    }
    return a !== "exec" && a !== "e";
  }
  return true;
}

/**
 * The arguments of process `pid` after argv[0], or undefined when it is gone.
 * Linux reads /proc (exact); elsewhere `ps` joins argv with spaces, so
 * argv[0] is cut as `comm` (the executable's path) when it leads.
 */
export function processArgs(pid: number): string[] | undefined {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return raw.split("\0").slice(1, -1);
    } catch {
      return undefined;
    }
  }
  try {
    const ps = (field: string) =>
      execFileSync("ps", ["-ww", "-o", `${field}=`, "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2_000,
        env: { ...process.env, LC_ALL: "C" },
      }).replace(/\n$/, "");
    const args = ps("args");
    const comm = ps("comm");
    if (!args) return undefined;
    const words = (s: string) => s.split(/\s+/).filter(Boolean);
    return comm && args.startsWith(comm)
      ? words(args.slice(comm.length))
      : words(args).slice(1);
  } catch {
    return undefined;
  }
}

/** Runs `bin args` with no shell; `code` is null when killed at its timeout. Rejects when it could not start. */
export type CodexRun = (
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ code: number | null; stderr: string }>;

const START_ERRORS = new Set(["ENOENT", "EACCES", "ENOEXEC"]);

export const execCodex =
  (timeoutMs = CODEX_QUEUE_TIMEOUT_MS): CodexRun =>
  (bin, args, env) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { timeout: timeoutMs, maxBuffer: 64 * 1024, env },
        (err, _stdout, stderr) => {
          if (!err) return resolve({ code: 0, stderr });
          const e = err as NodeJS.ErrnoException & {
            code?: number | string;
            killed?: boolean;
          };
          if (typeof e.code === "string" && START_ERRORS.has(e.code))
            return reject(err);
          resolve({
            code: e.killed || typeof e.code !== "number" ? null : e.code,
            stderr: String(stderr ?? ""),
          });
        },
      );
    });

/**
 * A message as the Codex thread reads it: the same notice as Pi and omp, with
 * the bus msg_id on the header line so a retry is recognisable.
 */
export function codexText(agent: AgentRecord, mail: Mail): string {
  const header = `${messageHeader({
    from: mail.from_name,
    to: agent.busName,
    namespace: mail.namespace,
    global: agent.global,
  })} (msg_id ${mail.msg_id})`;
  // OpenBus's own oversized notice is not peer text: it is never escaped.
  const text = mail.notice
    ? `${header}\n\n${mail.body}`
    : `${header}\n\n${neutralizeBody(stripTerminalControls(mail.body))}`;
  if (Buffer.byteLength(text) <= CODEX_TEXT_CAP) return text;
  return `${header}\n\n${oversizedText(mail.notice?.size ?? Buffer.byteLength(mail.body), mail.msg_id)}`;
}

export type CodexTransportOptions = {
  /** Finds the binary; called at start and again after a failure. */
  resolve: () => CodexBin | undefined;
  run: CodexRun;
  /** The CODEX_HOME attestation reads; `codex queue` writes there. */
  home: string;
  /** Whether Codex process `pid` is a host that wakes on a queued message. */
  wakes: (pid: number) => boolean;
  /**
   * msg_ids `codex queue` took (exit 0, or killed at its timeout and so
   * maybe taken), kept on disk: never queued twice, across restarts too.
   */
  queued: { has: (id: string) => boolean; add: (id: string) => void };
  log?: (msg: string) => void;
};

/**
 * Delivers to a Codex thread with the user's own `codex queue` (D2). A thread
 * loaded in a live host that wakes starts a turn with it: delivered once the
 * command exits 0. Otherwise (`codex exec`, or the host is gone) Codex holds
 * it for the next resume: queued, never acked, and not queued again.
 */
export class CodexTransport {
  #bin: CodexBin | undefined;
  #missingLogged = false;

  constructor(private readonly opts: CodexTransportOptions) {
    this.#bin = opts.resolve();
  }

  /** The binary in use, or undefined when none was found. */
  bin(): CodexBin | undefined {
    return this.#bin;
  }

  async deliver(agent: AgentRecord, mail: Mail): Promise<DeliverOutcome> {
    if (this.opts.queued.has(mail.msg_id)) return this.#reached(agent);
    this.#bin ??= this.opts.resolve();
    const bin = this.#bin;
    if (!bin) {
      // Stays pending at the hub, as for an offline agent; doctor says why.
      if (!this.#missingLogged)
        this.opts.log?.(
          "no codex binary found (config, PATH or the Codex app); Codex messages stay queued",
        );
      this.#missingLogged = true;
      return { ok: false, reason: "queued" };
    }
    this.#missingLogged = false;
    const args = [
      "queue",
      "--thread",
      agent.ref,
      "--message",
      codexText(agent, mail),
    ];
    let res: Awaited<ReturnType<CodexRun>>;
    try {
      res = await this.opts.run(bin.path, args, {
        ...process.env,
        CODEX_HOME: this.opts.home,
      });
    } catch (e) {
      this.#bin = undefined;
      this.opts.log?.(
        `codex queue could not start (${bin.path}): ${e instanceof Error ? e.message : String(e)}`,
      );
      return { ok: false, reason: "timeout" };
    }
    if (res.code === 0) {
      this.opts.queued.add(mail.msg_id);
      return this.#reached(agent);
    }
    if (res.code === null) {
      // It may have written the row: a second copy is worse than a late one.
      this.opts.queued.add(mail.msg_id);
      this.opts.log?.(
        `codex queue for ${agent.ref} timed out; not queued again`,
      );
      return { ok: false, reason: "queued" };
    }
    this.#bin = undefined;
    this.opts.log?.(
      `codex queue for ${agent.ref} exited ${res.code}: ${stripTerminalControls(res.stderr.trim()).slice(0, 300)}`,
    );
    return { ok: false, reason: "timeout" };
  }

  /** Taken by Codex: delivered if a live host that wakes has the thread, else queued. */
  #reached(agent: AgentRecord): DeliverOutcome {
    return agent.live && this.opts.wakes(agent.pid)
      ? { ok: true }
      : { ok: false, reason: "queued" };
  }
}

/** The default `wakes`: the process is there and is not `codex exec`. */
export const codexHostWakes = (pid: number): boolean => {
  const args = processArgs(pid);
  return args !== undefined && hostWakes(args);
};
