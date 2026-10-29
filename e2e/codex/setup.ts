// globalSetup for `pnpm e2e:codex`: builds the CLI bundle the way npm ships it
// (packages/cli/dist/index.js) and installs the pinned Codex CLI into its own
// prefix, never the global one. CI caches that prefix (ci.yml, job codex-e2e).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { psRows } from "@ob/daemon";
import type { TestProject } from "vitest/node";
import type { Listed } from "./stack.ts";

/** The CLIs the suite runs. Bump them here; CI's cache key hashes this file. */
export const CODEX_VERSION = "0.165.0";
export const CLAUDE_VERSION = "2.1.312";

const root = join(import.meta.dirname, "../..");

declare module "vitest" {
  export interface ProvidedContext {
    /** The pinned `codex` (npm's bin shim; it runs the native binary). */
    codexBin: string;
    /** The pinned `claude`. */
    claudeBin: string;
    /** The live process groups a worker started (stack.ts trackPids). */
    pidFile: string;
    /** The published-shape CLI bundle. */
    cliBundle: string;
  }
}

/** `OB_E2E_PREFIX`, else ~/.cache/ob-e2e-clis: one folder per package and version. */
export function prefixFor(name: string, version: string, env = process.env) {
  return join(
    env.OB_E2E_PREFIX || join(homedir(), ".cache", "ob-e2e-clis"),
    `${name.replace("/", "+")}@${version}`,
  );
}

/** npm-installs `name@version` into its own prefix (never the global one); its bin. */
function install(name: string, version: string, bin: string): string {
  const prefix = prefixFor(name, version);
  const pkg = join(prefix, "node_modules", name, "package.json");
  const installed = existsSync(pkg)
    ? (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version
    : undefined;
  if (installed !== version)
    execFileSync(
      "npm",
      [
        "install",
        "--no-save",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--prefix",
        prefix,
        `${name}@${version}`,
      ],
      { stdio: "inherit" },
    );
  const path = join(prefix, "node_modules/.bin", bin);
  const said = execFileSync(path, ["--version"], { encoding: "utf8" }).trim();
  if (!said.includes(version))
    throw new Error(`${path} says ${said}, not ${version}`);
  return path;
}

export default function setup(project: TestProject): () => void {
  // The release's version, as publish-npm stamps it: a 0.0.0 daemon is below
  // KIND_TOKEN_MIN_CLIENT, and the hub hides codex rows from it.
  const { version } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as { version: string };
  const pnpm = (...args: string[]) =>
    execFileSync("pnpm", args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, OB_CLI_VERSION: version },
    });
  pnpm("--filter", "@open-bus/cli", "build");
  project.provide("cliBundle", join(root, "packages/cli/dist/index.js"));
  const dir = mkdtempSync(join(tmpdir(), "ob-cxpids-"));
  const pidFile = join(dir, "groups");
  project.provide("pidFile", pidFile);
  project.provide("codexBin", install("@openai/codex", CODEX_VERSION, "codex"));
  project.provide(
    "claudeBin",
    install("@anthropic-ai/claude-code", CLAUDE_VERSION, "claude"),
  );
  // A worker killed before its afterAll (or its exit hook) leaves its groups
  // listed. A group is killed only while its leader is the very process this
  // run spawned: the same pid, still a group leader, with the recorded start
  // time. Anything else (a leader gone, a reused pid) is skipped, never killed.
  return () => {
    let listed: Listed[] = [];
    try {
      listed = JSON.parse(readFileSync(pidFile, "utf8")) as Listed[];
    } catch {}
    const pids = listed
      .map((l) => l.pid)
      .filter((p) => Number.isInteger(p) && p > 1);
    const starts = psRows(pids);
    const leaders = groupLeaders(pids);
    for (const { pid, start } of listed)
      if (leaders.has(pid) && starts.get(pid)?.start === start)
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
    rmSync(dir, { recursive: true, force: true });
  };
}

/** Which of `pids` lead their own process group (`ps -o pid=,pgid=`). */
function groupLeaders(pids: number[]): Set<number> {
  if (!pids.length) return new Set();
  let out = "";
  try {
    out = execFileSync("ps", ["-o", "pid=,pgid=", "-p", pids.join(",")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    // ps exits 1 when some pid is gone, and still prints the others.
    out = String((e as { stdout?: unknown }).stdout ?? "");
  }
  return new Set(
    out
      .trim()
      .split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter(([pid, pgid]) => pid !== undefined && pid === pgid)
      .map(([pid]) => pid as number),
  );
}
