import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

describe("e2e seed stays out of the real Worker", () => {
  it("no file under src/ imports test/e2e", () => {
    const offenders = walk(join(server, "src")).filter((f) =>
      /test\/e2e|__e2e/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => relative(server, f))).toEqual([]);
  });

  it("deploy paths reference only wrangler.jsonc", () => {
    const files = [
      join(repo, ".github/workflows/deploy-staging.yml"),
      join(repo, ".github/workflows/release-please.yml"),
      ...walk(join(repo, "scripts/setup")),
    ];
    const refs = files.flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/wrangler(\.[\w-]+)?\.jsonc/g)].map(
        (m) => `${relative(repo, f)}: ${m[0]}`,
      ),
    );
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !r.endsWith(": wrangler.jsonc"))).toEqual([]);
  });

  it("wrangler.e2e.jsonc mains the e2e entry and binds no route", () => {
    const cfg = readFileSync(join(server, "wrangler.e2e.jsonc"), "utf8");
    expect(cfg).toMatch(/"main":\s*"test\/e2e\/entry\.ts"/);
    expect(cfg).toMatch(/"workers_dev":\s*false/);
    expect(cfg).not.toMatch(/"routes"|"route"|custom_domain/);
  });

  it("a build of the real entry contains no __e2e", async () => {
    // Positive control: the probe does see the seed in the e2e entry.
    expect(await bundle("test/e2e/entry.ts")).toContain("__e2e");
    expect(await bundle("src/index.ts")).not.toContain("__e2e");
  }, 30_000);
});
