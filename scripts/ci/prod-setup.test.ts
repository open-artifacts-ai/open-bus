import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run as setupRun } from "../setup/src/index.ts";
import { ROOT } from "../setup/test/fakes.ts";
import { world } from "../setup/test/world.ts";
import { sandbox, script } from "./stubs.ts";

const MACHINE = `ob_machine_${"A".repeat(32)}`;
const ok = (step: string) => `{"step":"${step}","status":"ok"}`;
const PROD: Record<string, string> = {
  PROD_NAME: "open-bus-prod",
  PROD_APP_HOST: "bus.example.com",
  PROD_OWNER_EMAIL: "o@example.com",
};
const SCRATCH: Record<string, string> = {
  SCRATCH_NAME: "open-bus-scratch",
  SCRATCH_HOST: "scratch.example.com",
  PROD_OWNER_EMAIL: "o@example.com",
};

const run = (
  mode: string,
  lines: string[],
  env: Record<string, string> = PROD,
  pnpmExit = 0,
) => {
  const body = `cat <<'EOF_FIXTURE'\n${lines.join("\n")}\nEOF_FIXTURE\nexit ${pnpmExit}`;
  const sb = sandbox({ pnpm: body });
  const summary = join(mkdtempSync(join(tmpdir(), "sum-")), "summary.md");
  const r = sb.run(["bash", script("prod-setup.sh"), mode], {
    env: { GITHUB_STEP_SUMMARY: summary, ...env },
  });
  let sum = "";
  try {
    sum = readFileSync(summary, "utf8");
  } catch {}
  return { ...r, sum, calls: sb.log() };
};

describe("prod-setup.sh", () => {
  it("exits 0 and writes the summary when all steps are ok", () => {
    const r = run("install", [ok("prereqs"), ok("deploy")]);
    expect(r.code).toBe(0);
    expect(r.sum).toContain("| deploy | ok |");
    expect(r.calls[0]).toBe(
      "pnpm -s ob:setup --ci --name open-bus-prod --host bus.example.com --owner-email o@example.com",
    );
  });
  it("preflight is read-only JSON, upgrade passes --ci --upgrade", () => {
    const pre = run("preflight", [ok("a")]).calls[0] as string;
    expect(pre).toContain("--check --json");
    expect(pre).not.toContain("--upgrade");
    expect(pre).not.toContain("--ci");
    const up = run("upgrade", [ok("a")]).calls[0] as string;
    expect(up).toContain("--ci --upgrade");
    expect(up).not.toContain("--check");
  });
  it("cleanup has nothing to revoke: skipped, no setup call", () => {
    const r = run("cleanup", []);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"status":"skipped"');
    expect(r.calls).toEqual([]);
  });
  it("fails on action_required and on error lines", () => {
    const a = run("install", [
      ok("prereqs"),
      `{"step":"token","status":"action_required"}`,
    ]);
    expect(a.code).not.toBe(0);
    expect(a.sum).toContain("| token | action_required |");
    expect(run("install", [`{"step":"x","status":"error"}`]).code).not.toBe(0);
  });
  it("preflight fails on a todo line", () => {
    const r = run("preflight", [`{"step":"deploy","status":"todo"}`]);
    expect(r.code).not.toBe(0);
    expect(r.sum).toContain("| deploy | todo |");
  });
  it("propagates setup's exit code 2", () => {
    expect(run("preflight", [ok("a")], PROD, 2).code).toBe(2);
    expect(run("install", [ok("a")], PROD, 2).code).toBe(2);
    expect(run("install", [ok("a")], PROD, 1).code).toBe(1);
  });
  it("needs jq", () => {
    const sb = sandbox({ pnpm: "exit 0" });
    const r = sb.run(["/bin/bash", script("prod-setup.sh"), "install"], {
      env: { ...PROD, PATH: join(sb.dir, "bin") },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("jq is required");
    expect(sb.log()).toEqual([]);
  });
  it("fails when setup exits non-zero", () => {
    expect(run("install", [ok("a")], PROD, 1).code).not.toBe(0);
  });
  it("never prints ob_machine_ tokens or the Access token", () => {
    const r = run("install", [
      ok("a"),
      `{"step":"b","status":"ok","m":"${MACHINE}"}`,
    ]);
    expect(r.code).not.toBe(0);
    expect(r.out + r.err + r.sum).not.toContain(MACHINE);
    expect(r.err).toContain("token pattern found in output; aborting");
  });
  it("aborts on an echo of OB_ACCESS_TOKEN or CLOUDFLARE_API_TOKEN, trimmed or not", () => {
    for (const k of ["OB_ACCESS_TOKEN", "CLOUDFLARE_API_TOKEN"]) {
      for (const [secret, echoed] of [
        ["tok-abc123", "tok-abc123"],
        ["  tok-abc123 ", "tok-abc123"],
      ] as const) {
        const r = run(
          "install",
          [`{"step":"x","status":"ok","m":"${echoed}"}`],
          {
            ...PROD,
            [k]: secret,
          },
        );
        expect(r.code, `${k} ${JSON.stringify(secret)}`).not.toBe(0);
        expect(r.out + r.err + r.sum).not.toContain("tok-abc123");
      }
    }
  });
  it("passes tokens through env, never argv", () => {
    const r = run("install", [ok("a")], {
      ...PROD,
      CLOUDFLARE_API_TOKEN: "cf-SECRET-value",
      OB_ACCESS_TOKEN: "acc-SECRET-value",
    });
    expect(r.code).toBe(0);
    expect(r.calls.join("\n")).not.toContain("SECRET");
  });
  it("rejects an unknown mode without running setup", () => {
    const r = run("bogus", [ok("a")]);
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
  });
  it("requires PROD_* for the prod modes", () => {
    expect(run("install", [ok("a")], {}).code).not.toBe(0);
  });
});

describe("prod-setup.sh scratch modes", () => {
  it("scratch-install runs --json (no --ci, so state persists) with the SCRATCH_* name and host", () => {
    const r = run("scratch-install", [ok("a")], SCRATCH);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toBe(
      "pnpm -s ob:setup --json --name open-bus-scratch --host scratch.example.com --owner-email o@example.com",
    );
  });
  it("scratch-destroy confirms with the scratch name only", () => {
    const r = run("scratch-destroy", [ok("a")], SCRATCH);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toBe(
      "pnpm -s ob:setup --json --name open-bus-scratch --destroy --yes-destroy open-bus-scratch",
    );
  });
  it("scratch and staging refuse the prod name or host without running setup", () => {
    const bad: Record<string, string>[] = [
      { SCRATCH_NAME: "open-bus-prod" },
      { SCRATCH_HOST: "bus.leourbina.com" },
      { SCRATCH_NAME: "custom-prod", PROD_NAME: "custom-prod" },
      {
        SCRATCH_HOST: "custom.example.com",
        PROD_APP_HOST: "custom.example.com",
      },
    ];
    for (const m of ["scratch-install", "scratch-destroy"])
      for (const b of bad) {
        const r = run(m, [ok("a")], { ...SCRATCH, ...b });
        expect(r.code, `${m} ${JSON.stringify(b)}`).toBe(2);
        expect(r.calls).toEqual([]);
      }
  });
  it("requires the SCRATCH_* values", () => {
    expect(run("scratch-install", [ok("a")], {}).code).not.toBe(0);
  });
  it("scratch modes share the token scan and status handling", () => {
    for (const m of ["scratch-install", "scratch-destroy"]) {
      const r = run(
        m,
        [`{"step":"b","status":"ok","n":"${MACHINE}"}`],
        SCRATCH,
      );
      expect(r.code, m).not.toBe(0);
      expect(r.out + r.err).not.toContain(MACHINE);
    }
    expect(
      run("scratch-install", [`{"step":"x","status":"error"}`], SCRATCH).code,
    ).not.toBe(0);
  });
});

describe("scratch install then destroy, against setup's real state check", () => {
  // The argv scratch-install and scratch-destroy hand to setup.
  const argvOf = (mode: string) => {
    const r = run(mode, [ok("a")], {
      SCRATCH_NAME: "open-bus",
      SCRATCH_HOST: "bus.example.com",
      PROD_OWNER_EMAIL: "o@example.com",
    });
    return (r.calls[0] as string).replace("pnpm -s ob:setup ", "").split(" ");
  };
  const noop = {
    name: "noop",
    check: async () => "todo" as const,
    apply: async (state: { accountId?: string }) => {
      state.accountId = "acc1";
      return undefined;
    },
  };
  it("destroy finds the state the install left", async () => {
    const c = world({
      domains: [{ id: "d1", hostname: "bus.example.com", service: "open-bus" }],
    });
    expect(
      await setupRun(argvOf("scratch-install"), c.deps, ROOT, [noop]),
    ).toBe(0);
    expect(await setupRun(argvOf("scratch-destroy"), c.deps, ROOT)).toBe(0);
    expect(c.lines().at(-1)).toMatchObject({ step: "destroy", status: "ok" });
    expect(c.ops.filter((o) => o.startsWith("DELETE"))).toContain(
      "DELETE /accounts/acc1/workers/scripts/open-bus?force=true",
    );
  });
  it("a --ci install leaves no state, so destroy refuses (why scratch drops --ci)", async () => {
    const c = world();
    const ci = argvOf("scratch-install").map((a) =>
      a === "--json" ? "--ci" : a,
    );
    expect(await setupRun(ci, c.deps, ROOT, [noop])).toBe(0);
    expect(await setupRun(argvOf("scratch-destroy"), c.deps, ROOT)).toBe(1);
    expect(c.lines().at(-1).message).toContain("no setup state");
  });
});
