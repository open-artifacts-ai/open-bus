// I8 adversarial pass on CI secret handling. Each `it.fails` is a real finding.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { root, sandbox, script } from "./stubs.ts";

const wf = (name: string) =>
  parse(readFileSync(join(root, ".github/workflows", name), "utf8"));
type Step = {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};
type Job = {
  env?: Record<string, string>;
  permissions?: unknown;
  steps: Step[];
};

describe("I8 adversarial: workflows", () => {
  it.fails("I8-08 deploy-staging: pnpm install/build (dependency scripts) never see CLOUDFLARE_API_TOKEN", () => {
    const job: Job = wf("deploy-staging.yml").jobs.deploy;
    const untrusted = job.steps.filter((s) =>
      /pnpm (install|build)\b/.test(s.run ?? ""),
    );
    expect(untrusted.length).toBeGreaterThan(0);
    for (const s of untrusted)
      expect({ ...job.env, ...s.env }, s.run).not.toHaveProperty(
        "CLOUDFLARE_API_TOKEN",
      );
  });

  it.fails("I8-09 release-please: tag checkouts use refs/tags/ (a same-named branch cannot shadow the release)", () => {
    const jobs: Record<string, Job> = wf("release-please.yml").jobs;
    const refs = Object.values(jobs)
      .flatMap((j) => j.steps)
      .filter((s) => s.uses?.startsWith("actions/checkout") && s.with?.ref)
      .map((s) => String(s.with?.ref));
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(r).toMatch(/^refs\/tags\//);
  });

  it.fails("I8-10 release-please: deploy-prod (prod Cloudflare token) runs with contents: read, not the workflow's write scopes", () => {
    const job: Job = wf("release-please.yml").jobs["deploy-prod"];
    expect(job.permissions).toEqual({ contents: "read" });
  });
});

describe("I8 adversarial: prod-setup.sh scratch guard", () => {
  it.fails("I8-11 scratch-install and scratch-destroy refuse the staging Worker name and host", () => {
    for (const [mode, env] of [
      [
        "scratch-destroy",
        { SCRATCH_NAME: "open-bus-staging", SCRATCH_HOST: "s.example.com" },
      ],
      [
        "scratch-install",
        {
          SCRATCH_NAME: "open-bus-scratch",
          SCRATCH_HOST: "staging.open-bus.ai",
        },
      ],
    ] as const) {
      const sb = sandbox({ pnpm: "exit 0" });
      const r = sb.run(["bash", script("prod-setup.sh"), mode], {
        env: { ...env, PROD_OWNER_EMAIL: "o@example.com" },
      });
      expect(r.code, mode).toBe(2);
      expect(sb.log(), mode).toEqual([]);
    }
  });
});
