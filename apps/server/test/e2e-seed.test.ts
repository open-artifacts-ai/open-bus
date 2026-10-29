import { createExecutionContext } from "cloudflare:test";
import { LIMITS } from "@ob/shared";
import { describe, expect, it } from "vitest";
import { hub } from "../src/hub/stub.js";
import real, { Hub } from "../src/index.js";
import entry from "./e2e/entry.js";
import { daemon, e, upgrade } from "./helpers.js";

/** Calls the e2e entry directly, as wrangler dev would. */
type In = Parameters<typeof entry.fetch>[0];
const req = (url: string, init: RequestInit = {}) =>
  new Request(url, init) as In;
const call = (url: string, init: RequestInit = {}) =>
  entry.fetch(req(url, init), e, createExecutionContext());

/** The seed call; `X-OB-E2E: 1` is sent unless `headers` overrides it. */
const seed = (
  origin: string,
  body: unknown = {},
  headers: Record<string, string> = {},
) =>
  call(`${origin}/__e2e/machine`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-OB-E2E": "1",
      ...headers,
    },
    body: JSON.stringify(body),
  });

// Runs before the seed suite: its cap test fills the hub (storage persists per file).
describe("e2e machine revoke (DELETE /__e2e/machine/:id)", () => {
  const origin = "http://127.0.0.1:8787";
  const del = (
    id: string,
    headers: Record<string, string> = { "X-OB-E2E": "1" },
    o = origin,
  ) => call(`${o}/__e2e/machine/${id}`, { method: "DELETE", headers });
  const seeded = async () => {
    const res = await seed(origin, { label: "rv" });
    expect(res.status).toBe(200);
    return (await res.json()) as { machine_id: string; machine_token: string };
  };

  it("revokes through the hub: 204, then 404; the live socket closes 4403 and the token is refused", async () => {
    const m = await seeded();
    const d = await daemon(m.machine_token);
    const first = await del(m.machine_id);
    expect(first.status).toBe(204);
    expect((await d.closed).code).toBe(4403);
    const again = await del(m.machine_id);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ code: "not_found" });
    expect((await upgrade(m.machine_token)).status).toBe(401);
  });

  it("answers 404 for an unknown or malformed id, never touching another machine", async () => {
    const m = await seeded();
    for (const id of ["1111111111111111", "x", "..%2F..", ""])
      expect((await del(id)).status).toBe(404);
    expect((await upgrade(m.machine_token)).status).toBe(101);
  });

  it("refuses without the X-OB-E2E header or from a non-loopback host", async () => {
    const m = await seeded();
    expect((await del(m.machine_id, {})).status).toBe(403);
    expect(
      (
        await del(
          m.machine_id,
          { "X-OB-E2E": "1" },
          "https://staging.open-bus.ai",
        )
      ).status,
    ).toBe(403);
    // Neither refused call revoked it.
    expect((await upgrade(m.machine_token)).status).toBe(101);
  });

  it("other methods on the path go to the real worker", async () => {
    const url = `${origin}/__e2e/machine/1111111111111111`;
    const a = await call(url, { method: "GET" });
    const b = await real.fetch(
      req(url, { method: "GET" }),
      e,
      createExecutionContext(),
    );
    expect(a.status).toBe(b.status);
  });
});

describe("e2e machine seed (test/e2e/entry.ts)", () => {
  it("seeds a machine and answers the daemon's machine.json shape", async () => {
    const res = await seed("http://127.0.0.1:8787", { label: "t" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(
      ["hub", "label", "machine_id", "machine_token"].sort(),
    );
    expect(body.hub).toBe("http://127.0.0.1:8787");
    expect(body.label).toBe("t");
    // The seeded token opens /hub on the real worker.
    const up = await upgrade(body.machine_token as string);
    expect(up.status).toBe(101);
    up.webSocket?.accept();
    up.webSocket?.close(1000, "bye");
  });

  it.each(["http://localhost:8787", "http://[::1]:8787"])(
    "accepts loopback origin %s",
    async (origin) => {
      const res = await seed(origin);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { hub: string }).hub).toBe(origin);
    },
  );

  it.each([
    "https://staging.open-bus.ai",
    "https://app.localhost",
    "http://127.0.0.2:8787",
    "http://localhost.evil.com",
  ])("refuses 403 for non-loopback host %s", async (origin) => {
    const res = await seed(origin);
    expect(res.status).toBe(403);
  });

  // Under wrangler dev the URL host IS the Host header, so this check only
  // stops DNS rebinding; locality comes from the 127.0.0.1 bind
  // (wrangler.e2e.jsonc dev.ip, asserted in e2e-guards.node.test.ts).
  it("uses the URL host; other headers cannot vouch for loopback", async () => {
    const res = await seed(
      "https://staging.open-bus.ai",
      {},
      { "X-Forwarded-Host": "localhost", Origin: "http://localhost" },
    );
    expect(res.status).toBe(403);
  });

  // A custom header forces a CORS preflight, which nothing answers, so a web
  // page cannot mint machines with a simple cross-origin POST.
  it.each([
    ["missing", {}],
    ["not 1", { "X-OB-E2E": "true" }],
  ])("refuses 403 when X-OB-E2E is %s", async (_, h) => {
    const headers: Record<string, string> = {
      "content-type": "text/plain",
      ...h,
    };
    const res = await call("http://127.0.0.1:8787/__e2e/machine", {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "csrf" }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses an invalid label with 400", async () => {
    const res = await seed("http://127.0.0.1:8787", { label: " bad " });
    expect(res.status).toBe(400);
  });

  it("refuses a malformed body with 400", async () => {
    const res = await call("http://127.0.0.1:8787/__e2e/machine", {
      method: "POST",
      headers: { "X-OB-E2E": "1" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
  });

  it("passes every other request to the real worker unchanged", async () => {
    for (const [path, init] of [
      ["/hub", { headers: { Upgrade: "websocket" } }],
      ["/healthz", {}],
      ["/__e2e/other", { method: "POST" }],
    ] as const) {
      const url = `http://127.0.0.1:8787${path}`;
      const a = await call(url, init);
      const b = await real.fetch(req(url, init), e, createExecutionContext());
      expect([path, a.status, await a.text()]).toEqual([
        path,
        b.status,
        await b.text(),
      ]);
    }
    const get = await call("http://127.0.0.1:8787/__e2e/machine");
    expect(get.status).not.toBe(200);
  });

  it("answers 409 machine_limit at the cap", async () => {
    for (let i = 0; i < LIMITS.maxMachinesListed + 1; i++) {
      const r = await hub(e).createMachine(`fill-${i}`);
      if (!r.ok) break;
    }
    const res = await seed("http://127.0.0.1:8787");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "machine_limit" });
  }, 30_000);
});

describe("e2e link (POST /__e2e/link)", () => {
  const link = (
    body: unknown,
    headers: Record<string, string> = { "X-OB-E2E": "1" },
    origin = "http://127.0.0.1:8787",
  ) =>
    call(`${origin}/__e2e/link`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const aud = "https://artifacts.example.com";

  it("refuses a non-loopback host or a missing header", async () => {
    expect((await link({ aud }, {})).status).toBe(403);
    expect(
      (await link({ aud }, undefined, "https://bus.example.com")).status,
    ).toBe(403);
  });

  it("refuses an aud that is not an exact origin", async () => {
    for (const bad of [
      undefined,
      "https://a.example.com/path",
      "http://a.example.com",
    ]) {
      const r = await link({ aud: bad });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ code: "invalid_aud" });
    }
  });

  it("links through the hub's linkApp (409 when it refuses), or answers 501 until the hub has one", async () => {
    const r = await link({ aud });
    expect(r.status).toBe("linkApp" in Hub.prototype ? 204 : 501);
  });
});
