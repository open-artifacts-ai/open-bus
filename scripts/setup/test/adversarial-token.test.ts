import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { host } from "../src/steps/host.ts";
import { token } from "../src/steps/token.ts";
import { envelope, FLAGS, HOME, ROOT } from "./fakes.ts";
import { SEEDED, SETUP_TOKEN, world } from "./world.ts";

const TOKEN_FILE = `${HOME}/.openbus/open-bus-access-token`;
const DESTROY = [
  ...["--name", "open-bus", "--json", "--destroy"],
  "--yes-destroy=open-bus",
];

/** Answers GET /zones with [] for the setup token (what Cloudflare does for a token without Zone: Read on that zone). */
function blindZones(c: ReturnType<typeof world>) {
  const inner = c.deps.fetch;
  c.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const a = new Headers(init?.headers).get("authorization");
    if (u.pathname.endsWith("/zones") && a === `Bearer ${SETUP_TOKEN}`) {
      c.ops.push(`GET /zones${u.search}`);
      return envelope([]);
    }
    return inner(input, init);
  }) as typeof fetch;
}

describe("setup token: adversarial", () => {
  it("an old token without Zone: Read (or scoped to another zone) asks for Zone: Read, not to add a site the user has", async () => {
    const c = world({ state: SEEDED });
    blindZones(c);
    expect(await run(FLAGS, c.deps, ROOT, [token, host])).toBe(2);
    const l = c.lines().at(-1);
    expect(l).toMatchObject({ step: "host", status: "action_required" });
    expect(l.message).not.toContain("add-site");
    expect(l.message).toContain("Zone: Read");
    expect(l.data.url).toContain("dash.cloudflare.com/profile/api-tokens");
  });

  it("--destroy with a token lacking Workers Scripts: Read asks for it (exit 2), not exit 1", async () => {
    const c = world({ state: SEEDED, forbid: ["workers/domains"] });
    c.files.set(TOKEN_FILE, "access-token-0123456789");
    expect(await run(DESTROY, c.deps, ROOT)).toBe(2);
    const l = c.lines().at(-1);
    expect(l).toMatchObject({ step: "destroy", status: "action_required" });
    expect(l.message).toContain("Workers Scripts: Read");
    expect(c.ops.filter((o) => o.startsWith("DELETE"))).toEqual([]);
  });

  it("a stale state.zoneId from another host does not pre-fill the link", async () => {
    const c = world({
      state: { ...SEEDED, host: "bus.old.com", zoneId: "z-old.com" },
      env: { OB_ACCESS_TOKEN: "" },
    });
    expect(await run(FLAGS, c.deps, ROOT, [token])).toBe(2);
    const url = new URL(c.lines().at(-1).data.url);
    expect(url.searchParams.get("zoneId")).toBe("z-example.com");
  });

  it("a revoked setup token (401) asks for a new token instead of exit 1", async () => {
    const c = world({ state: SEEDED });
    const inner = c.deps.fetch;
    c.deps.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const a = new Headers(init?.headers).get("authorization");
      if (a === `Bearer ${SETUP_TOKEN}`)
        return envelope(null, 401, [{ message: "Invalid API Token" }]);
      return inner(input, init);
    }) as typeof fetch;
    expect(await run(FLAGS, c.deps, ROOT, [token, host])).toBe(2);
    const l = c.lines().at(-1);
    expect(l).toMatchObject({ step: "host", status: "action_required" });
    expect(l.data.url).toContain("dash.cloudflare.com/profile/api-tokens");
    expect(c.out()).not.toContain(SETUP_TOKEN);
  });

  it("--check with an unreadable token file reports token todo and keeps going", async () => {
    const c = world({ state: SEEDED, env: { OB_ACCESS_TOKEN: "" } });
    c.files.set(TOKEN_FILE, "access-token-0123456789");
    const fs = c.deps.fs;
    if (!fs) throw new Error("no fs");
    const readToken = fs.readToken;
    fs.readToken = (p) => {
      const f = readToken?.(p) ?? null;
      return f && p === TOKEN_FILE ? { ...f, mode: 0o644 } : f;
    };
    const code = await run([...FLAGS, "--check"], c.deps, ROOT, [token, host]);
    expect(code).toBe(2);
    expect(c.lines().map((l) => [l.step, l.status])).toEqual([
      ["token", "todo"],
      ["host", "todo"],
    ]);
    expect(c.prompts).toEqual([]);
  });
});

describe("setup token: OAuth zone fallback", () => {
  it("the wrangler login only locates the zone: every other read uses the setup token", async () => {
    const c = world({ state: SEEDED });
    blindZones(c);
    expect(await run(FLAGS, c.deps, ROOT, [token, host])).toBe(2);
    const oauth = c.auth.filter(([, a]) => a !== `Bearer ${SETUP_TOKEN}`);
    expect(oauth.length).toBeGreaterThan(0);
    for (const [op] of oauth) expect(op).toMatch(/^GET \/zones\?name=/);
    expect(c.ops.some((o) => /dns_records|workers\/domains/.test(o))).toBe(
      false,
    );
    expect(c.out()).not.toContain("cf-deploy-token-0001");
  });
});
