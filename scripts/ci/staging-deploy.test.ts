import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configVars,
  requiredSecrets,
  stripJsonc,
} from "../ops/check-staging-secrets.ts";
import { sandbox, script, write } from "./stubs.ts";

// Fixtures in the shape apps/server will have (02-backend.md): top-level vars
// in wrangler.jsonc, interface Env in src/env.ts. The scripts are pointed at
// them with WRANGLER_CONFIG / ENV_TS, so this suite needs no real Worker.
const envTs = [
  'import type { DurableObjectNamespace } from "@cloudflare/workers-types";',
  "export interface Env {",
  "  HUB: DurableObjectNamespace;",
  '  ENVIRONMENT: "production";',
  "  CF_ACCOUNT_ID: string;",
  "  ACCESS_CLIENT_SECRET: string;",
  "  SESSION_SECRET: string;",
  "  OPTIONAL?: string;",
  "}",
].join("\n");
const wrangler = `{
  // vars live at the top level in open-bus's wrangler.jsonc
  "name": "open-bus-staging",
  "vars": { "ENVIRONMENT": "production", "CF_ACCOUNT_ID": "x" },
}`;

const required = requiredSecrets(envTs, wrangler);
const vars = [...configVars(JSON.parse(stripJsonc(wrangler)))];
const list = (names: string[]) =>
  JSON.stringify(names.map((name) => ({ name, type: "secret_text" })));
// pnpm stub: `wrangler secret list` prints $SECRETS_JSON; everything else just logs.
const pnpm = '[[ "$*" == *"secret list"* ]] && printf %s "$SECRETS_JSON"; true';

/** A sandbox with the fixture files, and a runner pointed at them. */
function setup(stubs: Record<string, string>) {
  const sb = sandbox(stubs);
  write(join(sb.dir, "env.ts"), envTs);
  write(join(sb.dir, "wrangler.jsonc"), wrangler);
  const cfg = join(sb.dir, "wrangler.jsonc");
  const run = (name: string, env: Record<string, string> = {}) =>
    sb.run(["bash", script(name)], {
      env: { ...env, ENV_TS: join(sb.dir, "env.ts"), WRANGLER_CONFIG: cfg },
    });
  return { sb, cfg, run };
}

describe("staging-preflight.sh", () => {
  it("passes when all required secrets exist", () => {
    const h = setup({ pnpm });
    const r = h.run("staging-preflight.sh", { SECRETS_JSON: list(required) });
    expect(r.code).toBe(0);
    expect(h.sb.log()).toEqual([
      `pnpm exec wrangler secret list -c ${h.cfg} --format json`,
    ]);
  });
  it("fails and names a missing secret", () => {
    const h = setup({ pnpm });
    const r = h.run("staging-preflight.sh", {
      SECRETS_JSON: list(required.slice(1)),
    });
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).toContain(required[0]);
  });
});

describe("staging-preflight.sh with no required secrets", () => {
  it("passes without listing secrets when Env declares only vars (B2a)", () => {
    const sb = sandbox({ pnpm });
    write(
      join(sb.dir, "env.ts"),
      "export interface Env {\n  HUB: DurableObjectNamespace;\n  APP_HOST: string;\n  VERSION: string;\n}",
    );
    write(join(sb.dir, "wrangler.jsonc"), '{ "name": "open-bus-staging" }');
    const r = sb.run(["bash", script("staging-preflight.sh")], {
      env: {
        ENV_TS: join(sb.dir, "env.ts"),
        WRANGLER_CONFIG: join(sb.dir, "wrangler.jsonc"),
      },
    });
    expect(r.code).toBe(0);
    expect(sb.log()).toEqual([]);
  });
});

describe("staging-clear-conflicts.sh on a new Worker", () => {
  it("treats a Worker that does not exist yet as nothing to clear", () => {
    const h = setup({
      pnpm: 'echo "This Worker does not exist on your account. [code: 10007]"; exit 1',
    });
    const r = h.run("staging-clear-conflicts.sh");
    expect(r.code).toBe(0);
    expect(r.out).toContain("no Worker yet");
  });
  it("still fails on any other secret list error", () => {
    const h = setup({
      pnpm: 'echo "Authentication error [code: 10000]"; exit 1',
    });
    expect(h.run("staging-clear-conflicts.sh").code).not.toBe(0);
  });
});

describe("staging-clear-conflicts.sh", () => {
  const conflict = vars[0] as string;
  it("deletes only secrets that are also vars", () => {
    const h = setup({ pnpm });
    const r = h.run("staging-clear-conflicts.sh", {
      SECRETS_JSON: list([conflict, "NOT_A_VAR_SECRET"]),
    });
    expect(r.code).toBe(0);
    const deletes = h.sb.log().filter((l) => l.includes("secret delete"));
    expect(deletes).toEqual([
      `pnpm exec wrangler secret delete ${conflict} -c ${h.cfg}`,
    ]);
  });
  it("deletes nothing when there is no conflict", () => {
    const h = setup({ pnpm });
    const r = h.run("staging-clear-conflicts.sh", {
      SECRETS_JSON: list(["NOT_A_VAR_SECRET"]),
    });
    expect(r.code).toBe(0);
    expect(h.sb.log().some((l) => l.includes("secret delete"))).toBe(false);
  });
});

describe("ensure-dashboard-dist.sh", () => {
  it("writes a placeholder when the build produced no index.html", () => {
    const h = setup({});
    const dist = join(h.sb.dir, "dist");
    const r = h.run("ensure-dashboard-dist.sh", { DASHBOARD_DIST: dist });
    expect(r.code).toBe(0);
    expect(readFileSync(join(dist, "index.html"), "utf8")).toContain("<title>");
  });
  it("keeps an existing index.html", () => {
    const h = setup({});
    const dist = join(h.sb.dir, "dist");
    write(join(dist, "index.html"), "real");
    h.run("ensure-dashboard-dist.sh", { DASHBOARD_DIST: dist });
    expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("real");
  });
});
