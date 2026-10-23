import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("ci.yml release-dry-run job", () => {
  const w = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
  const text = readFileSync(
    join(root, ".github/workflows/ci.yml"),
    "utf8",
  ).replaceAll("\\", "");
  it("exists, is path-filtered, and calls the script", () => {
    const job = w.jobs["release-dry-run"];
    expect(job).toBeDefined();
    const s = JSON.stringify(job);
    for (const p of [
      "release-please-config.json",
      ".release-please-manifest.json",
      ".github/workflows/release-please.yml",
      "biome.json",
      "CHANGELOG.md",
    ])
      expect(text).toContain(p);
    expect(s).toContain("scripts/ci/release-dry-run.sh");
    expect(s).toMatch(/release-please@\d+\.\d+\.\d+/);
  });
  it("is not a required check", () => {
    const required = ["lint", "typecheck", "test", "build", "e2e"];
    expect(required).not.toContain("release-dry-run");
    // no other job may depend on it
    for (const j of Object.values(w.jobs) as { needs?: unknown }[])
      expect(JSON.stringify(j.needs ?? [])).not.toContain("release-dry-run");
  });
});

describe("workflows parse and name their surfaces", () => {
  const wf = (name: string) =>
    parse(readFileSync(join(root, ".github/workflows", name), "utf8"));
  it("all four workflows are valid YAML with the expected jobs", () => {
    expect(Object.keys(wf("ci.yml").jobs).sort()).toEqual([
      "build",
      "e2e",
      "lint",
      "release-dry-run",
      "test",
      "typecheck",
    ]);
    expect(Object.keys(wf("deploy-staging.yml").jobs).sort()).toEqual([
      "deploy",
      "smoke",
    ]);
    expect(Object.keys(wf("release-please.yml").jobs).sort()).toEqual([
      "deploy-prod",
      "release-please",
      "verify-release",
    ]);
    expect(Object.keys(wf("release-cadence.yml").jobs)).toEqual(["cadence"]);
  });
  it("ci.yml runs on the merge queue's merge_group event", () => {
    expect(wf("ci.yml").on.merge_group).toBeDefined();
  });
  it("deploy-staging gates on apps/server and never on D1", () => {
    const text = readFileSync(
      join(root, ".github/workflows/deploy-staging.yml"),
      "utf8",
    );
    expect(text).toContain("apps/server/wrangler.jsonc");
    expect(text).not.toContain("d1 migrations");
    expect(text).not.toContain("ANALYTICS");
  });
  it("release-please skips, not fails, without the release App secrets", () => {
    const steps = wf("release-please.yml").jobs["release-please"].steps;
    const gate = steps.find((s: { id?: string }) => s.id === "secrets");
    expect(gate.run).toContain("::notice");
    for (const id of ["app", "rp"])
      expect(steps.find((s: { id?: string }) => s.id === id).if).toContain(
        "steps.secrets.outputs.ok == 'true'",
      );
  });
  it("release-please prod jobs are gated on PROD_ENABLED", () => {
    const text = readFileSync(
      join(root, ".github/workflows/release-please.yml"),
      "utf8",
    );
    expect(text).toContain("vars.PROD_ENABLED == 'true'");
    expect(text).toContain("--prod-url");
    expect(text).not.toContain("demo");
  });
});
