import { describe, expect, it } from "vitest";
import { checkToken } from "./cf-token-check.ts";

type Routes = Record<string, [number, unknown]>;
const fake = (routes: Routes) => async (url: string) => {
  const path = url.replace("https://api.cloudflare.com/client/v4", "");
  const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
  const [status, result] = hit ? hit[1] : [404, null];
  return Response.json(
    { result, errors: status === 200 ? [] : [{ message: "denied" }] },
    { status },
  );
};
const full: Routes = {
  "/user/tokens/verify": [200, { status: "active" }],
  "/accounts/acc/workers/scripts": [200, []],
  "/accounts/acc/access/apps": [200, []],
  "/zones?name=a.test": [200, [{ id: "z1" }]],
  "/zones/z1/dns_records": [200, []],
  "/zones/z1/workers/routes": [200, []],
};

describe("cf-token-check", () => {
  it("passes when every permission is present", async () => {
    const r = await checkToken(fake(full), "t", "acc", ["a.test"]);
    expect(r.map((c) => c.name)).toEqual([
      "token",
      "workers-scripts",
      "access-apps",
      "zone a.test",
      "dns a.test",
      "routes a.test",
    ]);
    expect(r.every((c) => c.ok)).toBe(true);
  });
  it("names the missing permission on a 403", async () => {
    const r = await checkToken(
      fake({ ...full, "/accounts/acc/access/apps": [403, null] }),
      "t",
      "acc",
      ["a.test"],
    );
    const bad = r.find((c) => c.name === "access-apps");
    expect(bad?.ok).toBe(false);
    expect(bad?.detail).toContain("Access: Apps and Policies: Edit");
  });
  it("fails a zone that is not on the account", async () => {
    const r = await checkToken(
      fake({ ...full, "/zones?name=a.test": [200, []] }),
      "t",
      "acc",
      ["a.test"],
    );
    expect(r.find((c) => c.name === "zone a.test")?.ok).toBe(false);
    expect(r.some((c) => c.name.startsWith("dns"))).toBe(false);
  });
  it("stops after an inactive token", async () => {
    const r = await checkToken(
      fake({ ...full, "/user/tokens/verify": [200, { status: "disabled" }] }),
      "t",
      "acc",
    );
    expect(r).toHaveLength(1);
    expect(r[0].ok).toBe(false);
  });
  it("never puts the token in a result", async () => {
    const r = await checkToken(fake({}), "secret-tok", "acc");
    expect(JSON.stringify(r)).not.toContain("secret-tok");
  });
});
