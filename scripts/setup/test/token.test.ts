import { describe, expect, it } from "vitest";
import { run, STEPS } from "../src/index.ts";
import { host } from "../src/steps/host.ts";
import { token } from "../src/steps/token.ts";
import { linkFor, tokenById } from "../src/tokens.ts";
import { FLAGS, ROOT } from "./fakes.ts";
import { SEEDED, SETUP_TOKEN, world } from "./world.ts";

const keys = (url: string) =>
  JSON.parse(new URL(url).searchParams.get("permissionGroupKeys") ?? "[]");

describe("setup token", () => {
  it("asks for the setup token before the host check when none is saved", async () => {
    expect(STEPS.map((s) => s.name).slice(0, 3)).toEqual([
      "prereqs",
      "token",
      "host",
    ]);
    const c = world({ state: SEEDED, env: { OB_ACCESS_TOKEN: "" } });
    expect(await run(FLAGS, c.deps, ROOT, [token, host])).toBe(2);
    const l = c.lines().at(-1);
    expect(l).toMatchObject({ step: "token", status: "action_required" });
    expect(l.data.saveCommand).toContain("open-bus-access-token");
    expect(l.data.url).toContain("dash.cloudflare.com/profile/api-tokens");
    expect(c.ops.some((o) => o.includes("dns_records"))).toBe(false);
    expect(c.ops.filter((o) => !o.startsWith("GET"))).toEqual([]);
  });

  it("pre-fills the zone in the link when the host's zone is known", async () => {
    const c = world({ state: SEEDED, env: { OB_ACCESS_TOKEN: "" } });
    expect(await run(FLAGS, c.deps, ROOT, [token])).toBe(2);
    const url = new URL(c.lines().at(-1).data.url);
    expect(url.searchParams.get("zoneId")).toBe("z-example.com");
    expect(url.searchParams.get("accountId")).toBe("acc1");
  });

  it("--check reports todo without asking", async () => {
    const c = world({ state: SEEDED, env: { OB_ACCESS_TOKEN: "" } });
    expect(await run([...FLAGS, "--check"], c.deps, ROOT, [token])).toBe(2);
    expect(c.lines().at(-1)).toMatchObject({ step: "token", status: "todo" });
    expect(c.prompts).toEqual([]);
  });

  it("host reads DNS with the setup token, not the wrangler login", async () => {
    const c = world({ state: SEEDED });
    expect(await run(FLAGS, c.deps, ROOT, [token, host])).toBe(0);
    const reads = c.auth.filter(([op]) => /\/zones|workers\/domains/.test(op));
    expect(reads.some(([op]) => op.includes("dns_records"))).toBe(true);
    for (const [, a] of reads) expect(a).toBe(`Bearer ${SETUP_TOKEN}`);
  });

  it("a 403 on dns_records asks for DNS: Read, not an error", async () => {
    const c = world({ state: SEEDED, forbid: ["dns_records"] });
    expect(await run(FLAGS, c.deps, ROOT, [token, host])).toBe(2);
    const l = c.lines().at(-1);
    expect(l).toMatchObject({ step: "host", status: "action_required" });
    expect(l.message).toContain("DNS: Read");
    expect(l.data.url).toContain("dash.cloudflare.com/profile/api-tokens");
    expect(c.out()).not.toContain(SETUP_TOKEN);
  });

  it("the token link lists Access Apps Edit, Access Organizations Read, Zone Read, DNS Read", () => {
    const t = tokenById("access", { name: "open-bus" });
    expect(t.name).toBe("OpenBus open-bus setup");
    expect(t.file).toBe(".openbus/open-bus-access-token");
    expect(t.env).toBe("OB_ACCESS_TOKEN");
    const k = keys(linkFor(t, { accountId: "acc1", zoneId: "z1" }));
    for (const want of [
      { key: "access", type: "edit" },
      { key: "access_acct", type: "read" },
      { key: "zone", type: "read" },
      { key: "dns", type: "read" },
    ])
      expect(k).toContainEqual(want);
    expect(
      new URL(linkFor(t, { zoneId: "z1" })).searchParams.get("zoneId"),
    ).toBe("z1");
    expect(new URL(linkFor(t)).searchParams.has("zoneId")).toBe(false);
  });
});
