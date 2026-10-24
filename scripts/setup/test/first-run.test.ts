import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { healthcheck, selftest } from "../src/steps/selftest.ts";
import { FLAGS, ROOT } from "./fakes.ts";
import { SEEDED, VERSION, world } from "./world.ts";

const DEPLOYED = { ...SEEDED, deployedVersion: VERSION };
const dns = () =>
  Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });

/** Stands in for a fetch that resolves the host through 1.1.1.1. */
const viaPublic = (paths: string[]) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    paths.push(`${init?.method ?? "GET"} ${u.pathname}`);
    if (u.pathname === "/healthz") return Response.json({ version: VERSION });
    return Response.json(
      {
        device_code: "d",
        user_code: "BCDF-GH23",
        verification_uri: "https://bus.example.com/device",
        expires_in: 600,
        interval: 5,
      },
      { status: 201 },
    );
  }) as typeof fetch;

describe("first run on a new hostname (I9)", () => {
  it("healthcheck falls back to public DNS while local DNS still says ENOTFOUND", async () => {
    const c = world({ state: DEPLOYED, health: [dns()] });
    const paths: string[] = [];
    c.deps.publicFetch = viaPublic(paths);
    expect(await run(FLAGS, c.deps, ROOT, [healthcheck])).toBe(0);
    expect(paths).toContain("GET /healthz");
    expect(c.lines().at(-1).message).toContain("1.1.1.1");
  });

  it("selftest uses the same fallback", async () => {
    const c = world({ state: DEPLOYED });
    c.deps.fetch = (async () => {
      throw dns();
    }) as typeof fetch;
    const paths: string[] = [];
    c.deps.publicFetch = viaPublic(paths);
    expect(await run(FLAGS, c.deps, ROOT, [selftest])).toBe(0);
    expect(paths).toContain("POST /device/code");
  });

  it("an unresolved host says DNS is still propagating: wait and rerun", async () => {
    const c = world({ state: DEPLOYED, health: [dns()] });
    expect(await run(FLAGS, c.deps, ROOT, [healthcheck])).toBe(1);
    const msg = c.lines().at(-1).message;
    expect(msg).toContain("DNS for bus.example.com is still propagating");
    expect(msg).toContain("wait a few minutes and rerun");
    expect(msg).not.toContain("check the custom domain");
  });
});
