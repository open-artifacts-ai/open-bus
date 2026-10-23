import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../../../scripts/setup/src/jsonc.ts";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(server, "..", "..");

/** Every file under `dir`, recursively, skipping node_modules. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === "node_modules") return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** esbuild ships with wrangler; resolve it from there (no new dependency). */
const esbuild = createRequire(
  createRequire(join(server, "package.json")).resolve("wrangler"),
)("esbuild") as {
  build(o: object): Promise<{ outputFiles: { text: string }[] }>;
};

const bundle = async (entry: string): Promise<string> => {
  const r = await esbuild.build({
    entryPoints: [join(server, entry)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    logLevel: "silent",
  });
  return r.outputFiles.map((f) => f.text).join("\n");
};

type File = { path: string; text: string };

const isTest = (p: string) => /\.test\.ts$|(^|\/)test\//.test(p);
const isComment = (l: string) => /^\s*(#|\/\/|\*|\/\*)/.test(l);

/**
 * Deploy-path violations in `files` (paths relative to the repo):
 * - no mention of the e2e config or entry under .github/ or scripts/;
 * - every non-comment `wrangler deploy` in non-test files passes
 *   `-c wrangler.jsonc` literally (no variable), and no second -c/--config;
 * - a deploy argv built in TS (`"deploy", "-c"`) only in setup's deploy step.
 */
function deployViolations(files: File[]): string[] {
  const out: string[] = [];
  for (const { path, text } of files) {
    if (
      /^(\.github|scripts)\//.test(path) &&
      /wrangler\.e2e|test\/e2e/.test(text)
    )
      out.push(`${path}: mentions e2e`);
    if (isTest(path)) continue;
    text.split("\n").forEach((line, i) => {
      if (isComment(line) || !/wrangler\s+deploy\b/.test(line)) return;
      if (!/wrangler\s+deploy\s+(.*\s)?-c\s+wrangler\.jsonc(\s|$)/.test(line))
        out.push(`${path}:${i + 1}: wrangler deploy without -c wrangler.jsonc`);
      // A second -c/--config on the same line would override the literal one.
      const configs = line.match(/(^|\s)(-c|--config)(\s|=)/g) ?? [];
      if (configs.length > 1)
        out.push(`${path}:${i + 1}: wrangler deploy with more than one config`);
    });
    if (
      /"deploy",\s*"-c"/.test(text) &&
      path !== "scripts/setup/src/steps/deploy.ts"
    )
      out.push(`${path}: builds a deploy argv outside setup's deploy step`);
  }
  return out;
}

const deployTrees = (): File[] =>
  [
    ...walk(join(repo, ".github")),
    ...walk(join(repo, "scripts")),
    join(repo, "package.json"),
    join(server, "package.json"),
  ].map((f) => ({ path: relative(repo, f), text: readFileSync(f, "utf8") }));

describe("deployViolations (the checker itself)", () => {
  const yml = (run: string): File[] => [
    { path: ".github/workflows/deploy-staging.yml", text: run },
  ];
  it("passes the literal staging deploy", () => {
    expect(
      deployViolations(
        yml('  run: pnpm exec wrangler deploy -c wrangler.jsonc "$ARGS"'),
      ),
    ).toEqual([]);
  });
  it.each([
    ["a variable config", 'CFG=x.json\nwrangler deploy -c "$CFG"'],
    ["no -c", "wrangler deploy --var A:b"],
    ["the e2e config", "wrangler deploy -c wrangler.e2e.jsonc"],
    ["another json name", "wrangler deploy -c wrangler.jsonc.bak"],
    ["an e2e mention", "# see test/e2e/entry.ts"],
    [
      "a second --config after the literal one",
      'wrangler deploy -c wrangler.jsonc --config "$CFG"',
    ],
    [
      "a second -c= after the literal one",
      "wrangler deploy -c wrangler.jsonc -c=x.json",
    ],
  ])("flags %s", (_, run) => {
    expect(deployViolations(yml(run))).not.toEqual([]);
  });
  it("flags a TS deploy argv outside setup's deploy step", () => {
    const text = 'run(["deploy", "-c", cfg]);';
    expect(deployViolations([{ path: "scripts/ci/x.ts", text }])).not.toEqual(
      [],
    );
    expect(
      deployViolations([{ path: "scripts/setup/src/steps/deploy.ts", text }]),
    ).toEqual([]);
  });
});

describe("e2e seed stays out of the real Worker", () => {
  it("no file under src/ imports test/e2e", () => {
    const offenders = walk(join(server, "src")).filter((f) =>
      /test\/e2e|__e2e/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => relative(server, f))).toEqual([]);
  });

  it(".github/, scripts/ and package.json deploy only wrangler.jsonc", () => {
    const files = deployTrees();
    expect(files.length).toBeGreaterThan(10);
    expect(deployViolations(files)).toEqual([]);
    // The literal staging deploy is still there to be checked.
    const staging = readFileSync(
      join(repo, ".github/workflows/deploy-staging.yml"),
      "utf8",
    );
    expect(staging).toMatch(/wrangler deploy -c wrangler\.jsonc /);
  });

  it("setup renders its deploy config from wrangler.jsonc", () => {
    const step = readFileSync(
      join(repo, "scripts/setup/src/steps/deploy.ts"),
      "utf8",
    );
    expect(step).toMatch(/const CONFIG = "wrangler\.jsonc";/);
    expect(step).toMatch(/ctx\.fs\.read\(join\(dir, CONFIG\)\)/);
    expect(step).toMatch(/renderConfig\(text, /);
    expect(step).toMatch(/deployArgs\(/);
  });

  it("wrangler.e2e.jsonc mains the e2e entry, binds loopback, no route", () => {
    const cfg = parseJsonc(
      readFileSync(join(server, "wrangler.e2e.jsonc"), "utf8"),
    ) as Record<string, unknown>;
    expect(cfg.main).toBe("test/e2e/entry.ts");
    expect(cfg.workers_dev).toBe(false);
    expect(cfg.preview_urls).toBe(false);
    // Locality comes from this bind, not from the entry's host check.
    expect(cfg.dev).toMatchObject({ ip: "127.0.0.1", port: 8787 });
    for (const k of ["routes", "route", "assets"])
      expect(cfg).not.toHaveProperty(k);
  });

  it("package scripts build @ob/shared first and offer a state reset", () => {
    const pkg = JSON.parse(readFileSync(join(server, "package.json"), "utf8"))
      .scripts as Record<string, string>;
    expect(pkg.test).toMatch(/^pnpm --filter @ob\/shared build && /);
    expect(pkg["dev:e2e"]).toContain("-c wrangler.e2e.jsonc");
    expect(pkg["dev:e2e"]).toContain("--ip 127.0.0.1");
    // The reset removes .wrangler/state (run against a scratch dir).
    const dir = mkdtempSync(join(tmpdir(), "ob-e2e-reset-"));
    mkdirSync(join(dir, ".wrangler/state/v3"), { recursive: true });
    writeFileSync(join(dir, ".wrangler/state/v3/x"), "x");
    writeFileSync(join(dir, ".wrangler/keep"), "k");
    execFileSync("sh", ["-c", pkg["dev:e2e:reset"] as string], { cwd: dir });
    expect(existsSync(join(dir, ".wrangler/state"))).toBe(false);
    expect(existsSync(join(dir, ".wrangler/keep"))).toBe(true);
    // Idempotent: a second run on missing state succeeds.
    execFileSync("sh", ["-c", pkg["dev:e2e:reset"] as string], { cwd: dir });
  });

  it("a build of the real entry contains no __e2e", async () => {
    // Positive control: the probe does see the seed in the e2e entry.
    expect(await bundle("test/e2e/entry.ts")).toContain("__e2e");
    expect(await bundle("src/index.ts")).not.toContain("__e2e");
  }, 30_000);
});
