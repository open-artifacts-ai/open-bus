import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import type { Step } from "../src/step.ts";
import { deploy } from "../src/steps/deploy.ts";
import { host } from "../src/steps/host.ts";
import { secrets } from "../src/steps/secrets.ts";
import { envelope, FLAGS, ROOT } from "./fakes.ts";
import { SEEDED, world } from "./world.ts";

const SERVER = `${ROOT}/apps/server`;
/** B2a's apps/server/wrangler.jsonc (openbus-be-b2a): staging's own custom domain. */
const B2A_CONFIG = `{
  // Staging Worker. deploy-staging.yml overrides APP_HOST and VERSION with --var.
  "name": "open-bus-staging",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "routes": [{ "pattern": "staging.open-bus.ai", "custom_domain": true }],
  "assets": {
    "directory": "../dashboard/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": true
  },
  "vars": { "APP_HOST": "staging.open-bus.ai", "VERSION": "dev" },
  "observability": { "enabled": true }
}`;

const ACS = "access-client-secret-0123456789";
const seed: Step = {
  name: "seed",
  check: async () => "todo",
  apply: async (_s, ctx) => {
    ctx.secrets = { ...ctx.secrets, ACCESS_CLIENT_SECRET: ACS };
    return undefined;
  },
};

/** wrangler 4.152 resolveRoutes: `--route`s else config routes, PLUS every `--domain`. */
function effectiveRoutes(
  args: string[],
  cwd: string,
  read: (p: string) => string | undefined,
) {
  const flag = (f: string) =>
    args.flatMap((a, i) => (a === f ? [args[i + 1]] : []));
  const cfgPath = resolve(cwd, flag("-c")[0] ?? flag("--config")[0]);
  const cfg = JSON.parse(
    (read(cfgPath) ?? "{}").replace(/^\s*\/\/.*$/gm, ""),
  ) as { routes?: { pattern: string }[] };
  const routes = [...flag("--route"), ...flag("--routes")];
  const base = routes.length
    ? routes
    : (cfg.routes ?? []).map((r) => r.pattern);
  return [...base, ...flag("--domain"), ...flag("--domains")];
}

describe("adversarial: deploy", () => {
  it("deploy binds only --host: the config's own custom domain (staging.open-bus.ai) is not merged in", async () => {
    const c = world({ state: SEEDED });
    c.files.set(`${SERVER}/wrangler.jsonc`, B2A_CONFIG);
    expect(await run(FLAGS, c.deps, ROOT, [deploy])).toBe(0);
    const d = c.wrangler("deploy")[0];
    // The rendered config is removed after deploy: read it as wrangler saw it.
    const hosts = effectiveRoutes(d.args.slice(1), d.cwd ?? ROOT, (p) =>
      c.atDeploy().get(p),
    );
    expect(hosts).toEqual(["bus.example.com"]);
  });

  it("deploy refuses a host already bound to another Worker (non-TTY wrangler steals it)", async () => {
    const c = world({
      state: SEEDED,
      domains: [{ id: "d9", hostname: "bus.example.com", service: "other" }],
    });
    const code = await run(FLAGS, c.deps, ROOT, [host, deploy]);
    expect(c.wrangler("deploy")).toHaveLength(0);
    expect(code).toBe(2);
  });

  it("deploy refuses a host with a DNS record setup did not create (non-TTY wrangler overwrites it)", async () => {
    const c = world({ state: SEEDED });
    const f = c.deps.fetch;
    c.deps.fetch = (async (i: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(i));
      if (/\/zones\/[^/]+\/dns_records/.test(u.pathname))
        return envelope([
          {
            id: "r1",
            type: "A",
            name: "bus.example.com",
            content: "203.0.113.7",
          },
        ]);
      return f(i, init);
    }) as typeof fetch;
    const code = await run(FLAGS, c.deps, ROOT, [host, deploy]);
    expect(c.wrangler("deploy")).toHaveLength(0);
    expect(code).toBe(2);
  });

  it("deploy builds the dashboard assets (../dashboard/dist) before wrangler deploy", async () => {
    const c = world({ state: SEEDED });
    expect(await run(FLAGS, c.deps, ROOT, [deploy])).toBe(0);
    const i = c.calls.findIndex(
      (x) => x.args[0] === "wrangler" && x.args[1] === "deploy",
    );
    expect(
      c.calls.slice(0, i).some((x) => [x.cmd, ...x.args].includes("build")),
    ).toBe(true);
  });

  it("a zone not on the account is found before any write: no secret bulk (draft Worker)", async () => {
    const c = world({ state: SEEDED, secrets: "missing", zones: [] });
    expect(await run(FLAGS, c.deps, ROOT, [host, seed, secrets, deploy])).toBe(
      2,
    );
    expect(
      c.wrangler("secret").filter((x) => x.args[2] === "bulk"),
    ).toHaveLength(0);
  });

  it("the zone hint for bus.example.co.uk names example.co.uk, not the public suffix co.uk", async () => {
    const c = world({
      state: { ...SEEDED, host: "bus.example.co.uk" },
      zones: [],
    });
    const flags = [...FLAGS];
    flags[3] = "bus.example.co.uk";
    expect(await run(flags, c.deps, ROOT, [host, deploy])).toBe(2);
    const l = c.lines().at(-1);
    expect(l.message).not.toMatch(/zone co\.uk/);
    expect(l.data?.zone).toBe("example.co.uk");
  });
});

describe("adversarial: secrets", () => {
  it("a secret list failure that says 'Not Found' is an error, not 'no Worker' (SESSION_SECRET never rotated)", async () => {
    const c = world({
      state: SEEDED,
      secrets: ["ACCESS_CLIENT_SECRET", "SESSION_SECRET"],
    });
    const e = c.deps.exec;
    c.deps.exec = async (cmd, args, o) =>
      args[1] === "secret" && args[2] === "list"
        ? {
            code: 1,
            stdout: "",
            stderr:
              "npm error 404 Not Found - GET https://registry.npmjs.org/wrangler - Not found",
          }
        : e(cmd, args, o);
    const code = await run(FLAGS, c.deps, ROOT, [seed, secrets]);
    const bulk = c.wrangler("secret").filter((x) => x.args[2] === "bulk");
    for (const b of bulk)
      expect(Object.keys(JSON.parse(b.input ?? "{}"))).not.toContain(
        "SESSION_SECRET",
      );
    expect(code).toBe(1);
  });

  it("wrangler secret commands run from apps/server (the pinned wrangler), not the caller's cwd", async () => {
    const c = world({ state: SEEDED, secrets: "missing" });
    expect(await run(FLAGS, c.deps, ROOT, [seed, secrets])).toBe(0);
    const s = c.wrangler("secret");
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) expect(x.cwd).toBe(SERVER);
  });
});

describe("adversarial: destroy", () => {
  it("--destroy refuses a Worker setup has no record of (no state for --name)", async () => {
    const c = world({
      domains: [{ id: "d5", hostname: "api.example.com", service: "my-api" }],
    });
    const code = await run(
      ["--name", "my-api", "--json", "--destroy", "--yes-destroy=my-api"],
      c.deps,
      ROOT,
    );
    expect(c.ops.filter((o) => o.startsWith("DELETE"))).toEqual([]);
    expect(code).not.toBe(0);
  });

  it("destroy does not claim it deleted a Worker that was already gone", async () => {
    const c = world({ state: { ...SEEDED, accessAppId: undefined } });
    const f = c.deps.fetch;
    c.deps.fetch = (async (i: string | URL | Request, init?: RequestInit) =>
      init?.method === "DELETE" && String(i).includes("/workers/scripts/")
        ? envelope(null, 404)
        : f(i, init)) as typeof fetch;
    await run(
      ["--name", "open-bus", "--json", "--destroy", "--yes-destroy=open-bus"],
      c.deps,
      ROOT,
    );
    expect(c.lines().at(-1).message).not.toMatch(/deleted[^;]*Worker open-bus/);
  });
});
