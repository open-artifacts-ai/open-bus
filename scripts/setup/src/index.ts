import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  type Deps,
  type Fs,
  makeApi,
  makeWrangler,
  realDeps,
  realFs,
} from "./cf.ts";
import { readOnlyDeps, refuse } from "./readonly.ts";
import {
  homeOf,
  readState,
  type State,
  statePath,
  writeState,
} from "./state.ts";
import { type Ctx, NeedInput, type Opts, type Step } from "./step.ts";
import { prereqs } from "./steps/prereqs.ts";

// access, secrets, deploy, healthcheck and selftest join in I2 and I3.
export const STEPS: Step[] = [prereqs];

/**
 * One reported line. An install run uses ok | skipped | action_required | error.
 * `--check` is a read-only drift report: each step is `done` or `todo`, and it
 * exits 2 when any step is `todo`.
 */
export type Line = {
  step: string;
  status: "ok" | "skipped" | "action_required" | "error" | "done" | "todo";
  message: string;
  data?: unknown;
};
const ICON = {
  ok: "✓",
  skipped: "·",
  action_required: "!",
  error: "✗",
  done: "✓",
  todo: "○",
};

/** Env vars whose values are scrubbed from every reported line (wrangler honours the CF_ and API_KEY forms too). */
const SECRET_ENV = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_TOKEN",
  "CF_API_KEY",
  "OB_ACCESS_TOKEN",
] as const;
const MACHINE_TOKEN = /ob_machine_[1-9A-HJ-NP-Za-km-z]+/g;
const HOST = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const EMAIL = /^[^\s@"\\]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const NAME = /^[a-z0-9-]+$/;

function valid(flag: string, val: string, re: RegExp) {
  if (!re.test(val)) throw new Error(`invalid ${flag}: ${JSON.stringify(val)}`);
  return val;
}

/** Replaces every secret value (env and child env) and machine token with `***`, in strings and nested data. */
export function scrubber(
  ...envs: (Record<string, string | undefined> | undefined)[]
) {
  const secrets = envs
    .flatMap((env) => SECRET_ENV.map((k) => env?.[k]?.trim()))
    .filter((v): v is string => Boolean(v))
    // Longest first, so a secret containing another is replaced whole.
    .sort((a, b) => b.length - a.length);
  const str = (s: string) => {
    let out = s.replace(MACHINE_TOKEN, "***");
    for (const v of secrets) out = out.split(v).join("***");
    return out;
  };
  const deep = (x: unknown): unknown =>
    typeof x === "string"
      ? str(x)
      : Array.isArray(x)
        ? x.map(deep)
        : x && typeof x === "object"
          ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deep(v)]))
          : x;
  return { str, deep };
}

const OPTIONS = {
  name: { type: "string" },
  host: { type: "string" },
  "owner-email": { type: "string" },
  "account-id": { type: "string" },
  json: { type: "boolean", default: false },
  upgrade: { type: "boolean", default: false },
  check: { type: "boolean", default: false },
  ci: { type: "boolean", default: false },
} as const;
// --destroy, --yes-destroy and --token-links arrive with I3 and I2.

/** Parses flags; a stray positional (often a pasted token) is reported without echoing it. */
function flags(argv: string[]) {
  try {
    return parseArgs({ args: argv, strict: true, options: OPTIONS }).values;
  } catch (e) {
    if (
      (e as { code?: string }).code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"
    )
      throw new Error(
        "unexpected argument (not shown); every value needs its --flag",
      );
    throw e;
  }
}

export function parse(
  v: ReturnType<typeof flags>,
  name: string,
  state: State,
): Opts {
  const host = v.host ?? state.host;
  const ownerEmail = v["owner-email"] ?? state.ownerEmail;
  if (!v.check) {
    if (!host) throw new Error("missing --host");
    if (!ownerEmail) throw new Error("missing --owner-email");
  }
  return {
    name,
    host: host ? valid("--host", host.toLowerCase(), HOST) : "",
    ownerEmail: ownerEmail
      ? valid("--owner-email", ownerEmail.trim().toLowerCase(), EMAIL)
      : "",
    accountId: v["account-id"] ?? state.accountId,
    json: v.json || v.ci,
    upgrade: v.upgrade,
    check: v.check,
    ci: v.ci,
    destroy: false,
  };
}

/** Runs setup; returns the exit code: 0 done, 2 action required, 1 error. */
export async function run(
  argv: string[],
  deps: Deps,
  root: string,
  steps: Step[] = STEPS,
): Promise<number> {
  const fs = deps.fs ?? realFs;
  const home = homeOf(deps.env);
  const json = argv.some((a) => /^--(json|ci)(=|$)/.test(a));
  const scrub = scrubber(deps.env, deps.childEnv);
  const report = (raw: Line) => {
    const l = scrub.deep(raw) as Line;
    const line = json
      ? JSON.stringify(l)
      : `${ICON[l.status]} ${l.step}: ${l.message}${l.data === undefined ? "" : `\n  ${JSON.stringify(l.data)}`}`;
    deps.out(scrub.str(line));
  };

  let state: State = {};
  let opts: Opts;
  try {
    const v = flags(argv);
    const name = valid("--name", v.name ?? "open-bus", NAME);
    state = readState(fs, home, name);
    opts = parse(v, name, state);
  } catch (e) {
    report({ step: "args", status: "error", message: (e as Error).message });
    return 1;
  }

  const prompting = opts.json
    ? {
        ...deps,
        prompt: async () => {
          throw new NeedInput("--json never prompts; pass the value as a flag");
        },
      }
    : deps;
  const active = opts.check ? readOnlyDeps(prompting) : prompting;
  const ctxFs: Fs = opts.check
    ? {
        ...fs,
        write: (p) => {
          throw refuse(`write ${p}`);
        },
        writeSecret: (p) => {
          throw refuse(`write ${p}`);
        },
        removeTree: (p) => {
          throw refuse(`remove ${p}`);
        },
      }
    : fs;
  const wrangler = makeWrangler(active, root, () => state.accountId);
  const api = makeApi(active, wrangler);
  const accessToken = active.env.OB_ACCESS_TOKEN;
  const ctx: Ctx = {
    deps: active,
    fs: ctxFs,
    root,
    opts,
    api,
    accessApi: accessToken ? makeApi(active, wrangler, accessToken) : api,
    wrangler,
    notes: [],
  };
  state.name = opts.name;
  state.host = opts.host || state.host;
  state.ownerEmail = opts.ownerEmail || state.ownerEmail;
  const persist = () => {
    if (!opts.check && !opts.ci) writeState(fs, home, opts.name, state);
  };

  let todo = false;
  for (const step of steps) {
    ctx.data = ctx.human = undefined;
    ctx.skipped = false;
    try {
      const r = await step.check(state, ctx);
      if (opts.check) {
        if (r === "todo") todo = true;
        report({ step: step.name, status: r, message: r });
        continue;
      }
      let status: Line["status"] = "skipped";
      let message = step.okWhenDone ?? "already done";
      if (r === "todo") {
        const ar = await step.apply(state, ctx);
        if (ar) {
          report({ step: step.name, ...ar });
          persist();
          return 2;
        }
        status = ctx.skipped ? "skipped" : "ok";
        message = "done";
      } else if (step.okWhenDone) status = "ok";
      const notes = ctx.notes.splice(0).join("; ");
      report({
        step: step.name,
        status,
        message: notes ? `${message}; ${notes}` : message,
        ...(ctx.data !== undefined ? { data: ctx.data } : {}),
      });
      state.completed = [
        ...(state.completed ?? []).filter((s) => s !== step.name),
        step.name,
      ];
    } catch (e) {
      ctx.notes.length = 0;
      const ar = e instanceof NeedInput;
      report({
        step: step.name,
        status: ar ? "action_required" : "error",
        message: (e as Error).message,
        ...(ar && (e as NeedInput).data !== undefined
          ? { data: (e as NeedInput).data }
          : {}),
      });
      persist();
      return ar ? 2 : 1;
    }
  }
  persist();
  return todo ? 2 : 0;
}

export { statePath };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const deps = realDeps();
  // `pnpm ob:setup -- …` forwards a literal "--".
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  process.exit(await run(argv, { ...deps, fs: realFs }, root));
}
