import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DEPLOY_VARS } from "../ops/check-staging-secrets.ts";

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
  it("every workflow is valid YAML with the expected jobs", () => {
    expect(Object.keys(wf("ci.yml").jobs).sort()).toEqual([
      "build",
      "codex-e2e",
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
      "publish-npm",
      "release-please",
      "verify-release",
    ]);
    expect(Object.keys(wf("release-cadence.yml").jobs)).toEqual(["cadence"]);
    expect(Object.keys(wf("deploy-landing.yml").jobs)).toEqual(["deploy"]);
  });
  it("perf.yml is schedule + manual only, never a PR or merge-queue check (B12)", () => {
    const w = wf("perf.yml");
    expect(Object.keys(w.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(Object.keys(w.jobs)).toEqual(["perf"]);
    const runs = w.jobs.perf.steps.map((s: { run?: string }) => s.run ?? "");
    expect(
      runs.some(
        (r: string) =>
          r.includes("OB_PERF=1") && r.includes('-t "decode fast"'),
      ),
    ).toBe(true);
    expect(
      runs.some(
        (r: string) =>
          r.includes("OB_PERF=1") && r.includes("test/cpu.test.ts"),
      ),
    ).toBe(true);
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
  it("deploy-staging passes OWNER_EMAIL, ACCESS_TEAM_DOMAIN and ACCESS_CLIENT_ID from vars.STAGING_*", () => {
    const job = wf("deploy-staging.yml").jobs.deploy;
    for (const v of ["OWNER_EMAIL", "ACCESS_TEAM_DOMAIN", "ACCESS_CLIENT_ID"]) {
      expect(job.env[`STAGING_${v}`]).toBe(`\${{ vars.STAGING_${v} }}`);
      const deploy = job.steps.find(
        (s: { name?: string }) => s.name === "deploy",
      );
      expect(deploy.run).toContain(`--var "${v}:$STAGING_${v}"`);
      expect(deploy.run).toContain('if [ "$AUTH" = true ]');
    }
  });
  it("the deploy step's --var names are exactly DEPLOY_VARS", () => {
    const deploy = wf("deploy-staging.yml").jobs.deploy.steps.find(
      (s: { name?: string }) => s.name === "deploy",
    );
    const names = [...deploy.run.matchAll(/--var "([A-Z_]+):/g)].map(
      (m: RegExpMatchArray) => m[1],
    );
    expect(names.sort()).toEqual([...DEPLOY_VARS].sort());
  });
  it("smoke runs the device check only when the route policy lists POST /device/code", () => {
    const step = wf("deploy-staging.yml").jobs.smoke.steps.find(
      (s: { name?: string }) => s.name === "device flow",
    );
    expect(step.run).toContain(
      `grep -qF '"POST /device/code"' apps/server/src/auth/route-policy.ts`,
    );
    expect(step.run).toContain("staging-smoke.sh device");
    expect(step.run).toContain("::notice title=device smoke skipped::");
  });
  it("skips the deploy with a notice until those vars exist, only once env.ts declares them", () => {
    const gate = wf("deploy-staging.yml").jobs.deploy.steps.find(
      (s: { id?: string }) => s.id === "gate",
    );
    expect(gate.run).toContain("::notice title=staging deploy skipped::");
    for (const v of ["OWNER_EMAIL", "ACCESS_TEAM_DOMAIN", "ACCESS_CLIENT_ID"])
      expect(gate.run).toContain(`-z "$STAGING_${v}"`);
    expect(gate.run).toContain("check-staging-secrets.ts --access");
  });
  it("deploy-staging targets staging.open-bus.ai, not workers.dev", () => {
    const job = wf("deploy-staging.yml").jobs.deploy;
    expect(job.env.STAGING_HOST).toBe("staging.open-bus.ai");
    const text = readFileSync(
      join(root, ".github/workflows/deploy-staging.yml"),
      "utf8",
    );
    expect(text).not.toContain("workers/subdomain");
    expect(text).not.toContain("workers.dev");
    expect(text).toMatch(
      /healthz "https:\/\/\$\{\{ needs\.deploy\.outputs\.host \}\}"/,
    );
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
  it("publish-npm runs only when a release was created, with provenance", () => {
    const job = wf("release-please.yml").jobs["publish-npm"];
    expect(job.needs).toContain("release-please");
    expect(job.if).toContain("release_created == 'true'");
    expect(job.permissions["id-token"]).toBe("write");
    const text = JSON.stringify(job.steps);
    expect(text).toContain("npm publish");
    expect(text).toContain("--provenance --access public");
    // pnpm, not npm: it rewrites workspace: specs (C10 keeps @ob/* as devDeps).
    const publish = job.steps.find((s: { id?: string }) => s.id === "publish");
    expect(publish.run).toMatch(/^\s*pnpm publish .*--no-git-checks$/m);
    expect(publish.run).not.toMatch(/^\s*npm publish/m);
    expect(text).toMatch(/pnpm --filter \\"@open-bus\/cli\.\.\.\\" build/);
    expect(text).toContain("npm version");
  });
  it("publish-npm skips with a notice without NPM_TOKEN", () => {
    const steps = wf("release-please.yml").jobs["publish-npm"].steps;
    const gate = steps.find((s: { id?: string }) => s.id === "gate");
    expect(gate.run).toContain("::notice");
    expect(gate.run).toContain("NPM_TOKEN");
    expect(gate.run).toContain("private");
    expect(gate.run).toContain("build");
    const publish = steps.filter((s: { run?: string }) =>
      s.run?.includes("npm publish"),
    );
    expect(publish).toHaveLength(1);
    expect(publish[0].if).toContain("steps.exists.outputs.new == 'true'");
    const ex = steps.find((s: { id?: string }) => s.id === "exists");
    expect(ex.if).toContain("steps.gate.outputs.ok == 'true'");
  });
  it("publish-npm gate refuses unbundled workspace deps and a wrong repository", () => {
    const steps = wf("release-please.yml").jobs["publish-npm"].steps;
    const gate = steps.find((s: { id?: string }) => s.id === "gate");
    expect(gate.run).toContain('startsWith("workspace:")');
    expect(gate.run).toContain("C10 must bundle them");
    expect(gate.run).toContain("https://github.com/open-artifacts-ai/open-bus");
    expect(gate.run).toContain('"packages/cli"');
    expect(gate.run).toContain("repository.directory");
  });
  it("publish-npm publishes pre-releases to the next tag, and only new versions", () => {
    const steps = wf("release-please.yml").jobs["publish-npm"].steps;
    const pub = steps.find((s: { id?: string }) => s.id === "publish");
    expect(pub.run).toContain("*-*");
    expect(pub.run).toContain("--tag next");
    const ex = steps.find((s: { id?: string }) => s.id === "exists");
    expect(ex.run).toContain('npm view "@open-bus/cli@$v" version');
    expect(pub.if).toContain("steps.exists.outputs.new == 'true'");
  });
  it("publish-npm outputs published, set only after npm publish, and keeps the token out of the gate", () => {
    const job = wf("release-please.yml").jobs["publish-npm"];
    expect(job.outputs.published).toContain("steps.publish.outputs.published");
    // A version already on npm counts as published, so verify-release still checks it.
    expect(job.outputs.published).toContain("steps.exists.outputs.published");
    const exists = job.steps.find((s: { id?: string }) => s.id === "exists");
    expect(exists.run).toMatch(/new=false[\s\S]*published=true/);
    const pub = job.steps.find((s: { id?: string }) => s.id === "publish");
    expect(pub.run.indexOf("npm publish")).toBeLessThan(
      pub.run.indexOf("published=true"),
    );
    expect(pub.env.NODE_AUTH_TOKEN).toContain("secrets.NPM_TOKEN");
    const gate = job.steps.find((s: { id?: string }) => s.id === "gate");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal Actions expression and bash array, not a JS template
    expect(gate.env).toEqual({ HAS_NPM: "${{ secrets.NPM_TOKEN != '' }}" });
    const withToken = job.steps.filter((s: { env?: Record<string, string> }) =>
      Object.keys(s.env ?? {}).some((k) => k === "NODE_AUTH_TOKEN"),
    );
    expect(withToken.map((s: { id?: string }) => s.id)).toEqual(["publish"]);
    expect(
      job.steps.find((s: { run?: string }) => s.run?.includes("pnpm install"))
        .run,
    ).toContain("--ignore-scripts");
  });
  it("verify-release skips npm unless publish-npm published, with a quoted array of flags", () => {
    const v = wf("release-please.yml").jobs["verify-release"];
    expect(v.needs).toContain("publish-npm");
    const step = v.steps.find((s: { name?: string }) =>
      s.name?.startsWith("Verify"),
    );
    expect(step.env.PUBLISHED).toContain("needs.publish-npm.outputs.published");
    expect(step.run).toContain('flags+=(--site-url "$SITE_URL")');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal Actions expression and bash array, not a JS template
    expect(step.run).toContain('"${flags[@]}"');
    expect(step.run).not.toContain("package.json");
    expect(step.run).not.toContain("NPM_TOKEN");
  });
  it("verify-release passes skip flags when prerequisites are absent", () => {
    const text = readFileSync(
      join(root, ".github/workflows/release-please.yml"),
      "utf8",
    );
    expect(text).toContain("--skip-npm");
    expect(text).toContain("--skip-llms");
    expect(text).toContain("--site-url");
  });
  it("deploy-landing runs on pushes to main that touch the landing or install docs, and on dispatch", () => {
    const w = wf("deploy-landing.yml");
    expect(w.on.push.branches).toEqual(["main"]);
    expect(w.on.push.paths).toEqual(
      expect.arrayContaining(["apps/landing/**", "docs/install/**"]),
    );
    expect(Object.keys(w.on).sort()).toEqual(["push", "workflow_dispatch"]);
    const job = w.jobs.deploy;
    // Public: off unless the user turned it on.
    expect(job.if).toContain("vars.LANDING_ENABLED == 'true'");
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.concurrency.group).toBe("landing");
  });
  it("deploy-landing deploys apps/landing/dist as assets with the open-bus.ai custom domain", () => {
    const job = wf("deploy-landing.yml").jobs.deploy;
    const text = JSON.stringify(job.steps);
    expect(text).toContain("pnpm --filter @ob/landing build");
    expect(text).toContain("wrangler deploy -c wrangler.jsonc");
    expect(text).toContain("https://open-bus.ai/llms.txt");
    expect(text).toContain("npx @open-bus/cli");
    const cfg = readFileSync(join(root, "apps/landing/wrangler.jsonc"), "utf8");
    expect(cfg).toContain('"name": "open-bus-landing"');
    expect(cfg).toContain('"directory": "./dist"');
    expect(cfg).toMatch(/"pattern": "open-bus\.ai", "custom_domain": true/);
    expect(cfg).toContain('"workers_dev": false');
  });
  it("release-please prod jobs are gated on PROD_ENABLED", () => {
    const text = readFileSync(
      join(root, ".github/workflows/release-please.yml"),
      "utf8",
    );
    expect(text).toContain("vars.PROD_ENABLED == 'true'");
    // OpenBus has one host per instance; OA's content host is gone (I9).
    expect(text).not.toContain("PROD_CONTENT_HOST");
    expect(text).toContain("--prod-url");
    expect(text).not.toContain("demo");
  });
});
