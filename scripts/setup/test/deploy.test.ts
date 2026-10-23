import { describe, expect, it } from "vitest";
import { makeWrangler, wranglerDir } from "../src/cf.ts";
import { run, STEPS } from "../src/index.ts";
import { BUILD, deploy, deployArgs } from "../src/steps/deploy.ts";
import { host, zoneGuess } from "../src/steps/host.ts";
import { core, FLAGS, ROOT } from "./fakes.ts";
import { SEEDED, VERSION, world } from "./world.ts";

const access = { teamDomain: SEEDED.teamDomain, clientId: "cid-1" };
const opts = {
  name: "open-bus",
  host: "bus.example.com",
  ownerEmail: "o@example.com",
};
const SERVER = `${ROOT}/apps/server`;
const CONFIG = `{
  // B2a's shape
  "name": "open-bus-staging",
  "main": "src/index.ts",
  "routes": [{ "pattern": "staging.open-bus.ai", "custom_domain": true }],
  "assets": { "directory": "../dashboard/dist", "binding": "ASSETS" },
}`;
const tempFiles = (files: Map<string, string>) =>
  [...files.keys()].filter((k) => k.startsWith("/tmp/"));

describe("deploy", () => {
  it("deploys with --name, the custom-domain route and every var", async () => {
    const args = deployArgs(opts, access, VERSION, "/tmp/x/wrangler.json");
    const pair = (a: string, b: string) =>
      args.some((x, i) => x === a && args[i + 1] === b);
    expect(pair("--name", "open-bus")).toBe(true);
    expect(pair("-c", "/tmp/x/wrangler.json")).toBe(true);
    expect(args).not.toContain("--domain");
    for (const v of [
      "ENVIRONMENT:production",
      "APP_HOST:bus.example.com",
      "OWNER_EMAIL:o@example.com",
      `ACCESS_TEAM_DOMAIN:${SEEDED.teamDomain}`,
      "ACCESS_CLIENT_ID:cid-1",
      `VERSION:${VERSION}`,
    ])
      expect(pair("--var", v)).toBe(true);

    const c = world({ state: SEEDED });
    c.files.set(`${SERVER}/wrangler.jsonc`, CONFIG);
    expect(await run(FLAGS, c.deps, ROOT, [deploy])).toBe(0);
    const d = c.wrangler("deploy");
    expect(d).toHaveLength(1);
    const cfgPath = d[0].args[d[0].args.indexOf("-c") + 1];
    expect(d[0].args.slice(1)).toEqual(
      deployArgs(opts, access, VERSION, cfgPath),
    );
    expect(d[0].cwd).toBe(SERVER);
    expect(c.state()).toMatchObject({
      deployedVersion: VERSION,
      host: "bus.example.com",
    });
    expect(c.lines().at(-1)).toMatchObject({ step: "deploy", status: "ok" });
  });

  it("renders the config in a temp dir with absolute main and assets, and removes it", async () => {
    const c = world({ state: SEEDED });
    c.files.set(`${SERVER}/wrangler.jsonc`, CONFIG);
    const before = [...c.files.keys()].filter((k) => k.startsWith(SERVER));
    expect(await run(FLAGS, c.deps, ROOT, [deploy])).toBe(0);
    const d = c.wrangler("deploy")[0];
    const cfgPath = d.args[d.args.indexOf("-c") + 1];
    expect(cfgPath.startsWith("/tmp/")).toBe(true);
    expect(JSON.parse(c.atDeploy().get(cfgPath) ?? "{}")).toMatchObject({
      name: "open-bus",
      main: `${SERVER}/src/index.ts`,
      assets: { directory: `${ROOT}/apps/dashboard/dist`, binding: "ASSETS" },
      routes: [{ pattern: "bus.example.com", custom_domain: true }],
    });
    expect(tempFiles(c.files)).toEqual([]);
    expect([...c.files.keys()].filter((k) => k.startsWith(SERVER))).toEqual(
      before,
    );
  });

  it("removes the temp config when wrangler deploy fails", async () => {
    const c = world({ state: SEEDED });
    c.failOn((a) => a[1] === "deploy");
    expect(await run(FLAGS, c.deps, ROOT, [deploy])).toBe(1);
    expect(c.wrangler("deploy")).toHaveLength(1);
    expect(tempFiles(c.files)).toEqual([]);
  });

  it("builds only the dashboard and its deps, with no token in the env", async () => {
    const c = world({
      state: SEEDED,
      env: {
        CLOUDFLARE_API_KEY: "k-0001",
        CF_API_TOKEN: "cf-0001",
        OB_ACCESS_TOKEN: "ob-0001",
        PATH: "/usr/bin",
      },
    });
    expect(await run(FLAGS, c.deps, ROOT, [deploy])).toBe(0);
    const b = c.calls.find((x) => x.cmd === "pnpm");
    expect(b?.args).toEqual(BUILD);
    expect(BUILD).toEqual(["--filter", "@ob/dashboard...", "build"]);
    expect(b?.cwd).toBe(ROOT);
    expect(b?.replaceEnv).toBe(true);
    expect(b?.env?.PATH).toBe("/usr/bin");
    for (const k of [
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_API_KEY",
      "CF_API_TOKEN",
      "OB_ACCESS_TOKEN",
    ])
      expect(b?.env).not.toHaveProperty(k);
  });

  it("errors when the build leaves no dashboard index.html", async () => {
    const c = world({ state: SEEDED });
    c.files.delete(`${ROOT}/apps/dashboard/dist/index.html`);
    expect(await run(FLAGS, c.deps, ROOT, [deploy])).toBe(1);
    expect(c.lines().at(-1).message).toContain(
      "apps/dashboard/dist/index.html",
    );
    expect(c.files.has(`${ROOT}/apps/dashboard/dist/index.html`)).toBe(false);
    expect(c.wrangler("deploy")).toHaveLength(0);
  });

  it("refuses a host whose zone is not on the account", async () => {
    const c = world({ state: SEEDED, zones: [] });
    expect(await run(FLAGS, c.deps, ROOT, [host, deploy])).toBe(2);
    const l = c.lines().at(-1);
    expect(l).toMatchObject({ step: "host", status: "action_required" });
    expect(l.message).toContain("example.com");
    expect(c.ops).toContain("GET /zones?name=example.com&account.id=acc1");
    expect(c.wrangler("deploy")).toHaveLength(0);
  });

  it("finds a zone deeper than the registrable domain", async () => {
    const c = world({
      state: { ...SEEDED, host: "a.bus.example.com" },
      zones: ["bus.example.com"],
    });
    const flags = [...FLAGS];
    flags[3] = "a.bus.example.com";
    expect(await run(flags, c.deps, ROOT, [host, deploy])).toBe(0);
  });

  it("checks the host right after prereqs, before access writes anything", () => {
    const names = STEPS.map((s) => s.name);
    expect(names.slice(0, 3)).toEqual(["prereqs", "host", "access"]);
  });

  it("guesses the zone from known second-level labels", () => {
    expect(zoneGuess("bus.example.co.uk")).toBe("example.co.uk");
    expect(zoneGuess("a.b.com.au")).toBe("b.com.au");
    expect(zoneGuess("bus.foo.io")).toBe("foo.io");
    expect(zoneGuess("bus.abc.de")).toBe("abc.de");
    expect(zoneGuess("bus.example.com")).toBe("example.com");
  });

  it("skips under --check", async () => {
    const c = world({ state: SEEDED });
    expect(await run([...FLAGS, "--check"], c.deps, ROOT, [deploy])).toBe(2);
    expect(c.lines().at(-1)).toMatchObject({ step: "deploy", status: "todo" });
    const d = world({ state: { ...SEEDED, deployedVersion: VERSION } });
    expect(await run([...FLAGS, "--check"], d.deps, ROOT, [deploy])).toBe(0);
    expect(c.wrangler("deploy")).toHaveLength(0);
    expect(d.wrangler("deploy")).toHaveLength(0);
  });

  it("refuses without the Access app in state", async () => {
    const { accessClientId: _, ...rest } = SEEDED;
    const c = world({ state: rest });
    expect(await run(FLAGS, c.deps, ROOT, [deploy])).toBe(1);
    expect(c.wrangler("deploy")).toHaveLength(0);
  });

  it("refuses when apps/server/wrangler.jsonc is missing", async () => {
    const c = world({ state: SEEDED });
    c.files.delete(`${ROOT}/apps/server/wrangler.jsonc`);
    expect(await run(FLAGS, c.deps, ROOT, [deploy])).toBe(1);
    expect(c.lines().at(-1).message).toContain("apps/server/wrangler.jsonc");
  });
});

describe("wrangler cwd", () => {
  it("runs from apps/server, or the root when apps/server is missing", async () => {
    const seen: (string | undefined)[] = [];
    const c = core({
      exec: async (_c, _a, o) => {
        seen.push(o?.cwd);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(wranglerDir(c.deps, ROOT)).toBe(ROOT);
    await makeWrangler(c.deps, ROOT, () => undefined)(["--version"]);
    c.files.set(`${SERVER}/package.json`, "{}");
    expect(wranglerDir(c.deps, ROOT)).toBe(SERVER);
    await makeWrangler(c.deps, ROOT, () => undefined)(["--version"]);
    expect(seen).toEqual([ROOT, SERVER]);
  });
});
