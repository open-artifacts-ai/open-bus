// globalSetup for `pnpm e2e:codex`: builds the CLI bundle the way npm ships it
// (packages/cli/dist/index.js) and installs the pinned Codex CLI into its own
// prefix, never the global one. CI caches that prefix (ci.yml, job codex-e2e).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

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
  pnpm("--filter", "@ob/shared", "build");
  pnpm("--filter", "@open-bus/cli", "build");
  project.provide("cliBundle", join(root, "packages/cli/dist/index.js"));
  const pids = mkdtempSync(join(tmpdir(), "ob-cxpids-"));
  const pidFile = join(pids, "groups");
  project.provide("pidFile", pidFile);
  project.provide("codexBin", install("@openai/codex", CODEX_VERSION, "codex"));
  project.provide(
    "claudeBin",
    install("@anthropic-ai/claude-code", CLAUDE_VERSION, "claude"),
  );
  // A worker killed before its afterAll (or its exit hook) leaves its groups
  // listed: kill them, then the list. Only pids this run spawned are in it.
  return () => {
    let listed: number[] = [];
    try {
      listed = readFileSync(pidFile, "utf8").split("\n").map(Number);
    } catch {}
    for (const pid of listed)
      if (Number.isInteger(pid) && pid > 1)
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
    rmSync(pids, { recursive: true, force: true });
  };
}
