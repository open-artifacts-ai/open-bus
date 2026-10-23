import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { deploy, deployArgs } from "../src/steps/deploy.ts";
import { FLAGS, ROOT } from "./fakes.ts";
import { SEEDED, VERSION, world } from "./world.ts";

const access = { teamDomain: SEEDED.teamDomain, clientId: "cid-1" };
const opts = {
  name: "open-bus",
  host: "bus.example.com",
  ownerEmail: "o@example.com",
};

describe("deploy", () => {
  it("deploys with --name, the custom-domain route and every var", async () => {
    const args = deployArgs(opts, access, VERSION);
    const pair = (a: string, b: string) =>
      args.some((x, i) => x === a && args[i + 1] === b);
    expect(pair("--name", "open-bus")).toBe(true);
    expect(pair("-c", "wrangler.setup-open-bus.jsonc")).toBe(true);
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
    expect(await run(FLAGS, c.deps, ROOT, [deploy])).toBe(0);
    const d = c.wrangler("deploy");
    expect(d).toHaveLength(1);
    expect(d[0].args.slice(1)).toEqual(args);
    expect(d[0].cwd).toBe(`${ROOT}/apps/server`);
    const rendered = JSON.parse(
      c.files.get(`${ROOT}/apps/server/wrangler.setup-open-bus.jsonc`) ?? "{}",
    );
    expect(rendered).toMatchObject({
      name: "open-bus",
      routes: [{ pattern: "bus.example.com", custom_domain: true }],
    });
    expect(c.state()).toMatchObject({
      deployedVersion: VERSION,
      host: "bus.example.com",
    });
    expect(c.lines().at(-1)).toMatchObject({ step: "deploy", status: "ok" });
  });

  it("refuses a host whose zone is not on the account", async () => {
    const c = world({ state: SEEDED, zones: [] });
    expect(await run(FLAGS, c.deps, ROOT, [deploy])).toBe(2);
    const l = c.lines().at(-1);
    expect(l).toMatchObject({ step: "deploy", status: "action_required" });
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
    expect(await run(flags, c.deps, ROOT, [deploy])).toBe(0);
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
