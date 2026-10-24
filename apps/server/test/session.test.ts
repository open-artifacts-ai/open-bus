// B2b: the policy gate reads sessions, plus CSRF and same-origin on session mutations.
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  CSRF_HEADER,
  EVENTS_DO_PATH,
  SESSION_EXP_HEADER,
  SESSION_GEN_HEADER,
  STATUS_FOR,
} from "@ob/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import * as maxAge from "../src/auth/max-age.js";
import { ROUTE_POLICY } from "../src/auth/route-policy.js";
import * as sessionModule from "../src/auth/session.js";
import {
  OWNER_UID,
  readSession,
  type Session,
  sessionCookie,
  sessionCookieName,
  sessionGeneration,
  signSession,
} from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { hub, hubFetch } from "../src/hub/stub.js";

const base = env as unknown as Env;
const ORIGIN = `https://${base.APP_HOST}`;
type ErrorBody = { error: { code: string; message: string } };

/** A HUB whose every RPC throws (the hub is down). */
const downHub = () =>
  ({
    idFromName: () => ({}),
    get: () =>
      new Proxy(
        {},
        {
          get: () => async () => {
            throw new Error("hub down");
          },
        },
      ),
  }) as unknown as Env["HUB"];

let ran = 0;
const seen: Session[] = [];
const MUTATIONS = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** Test-only session routes; the handler records what the gate set. */
const app = createApp(
  (a) => {
    a.on(["GET", ...MUTATIONS], "/s", (c) => {
      ran++;
      const s = c.get("session");
      seen.push(s);
      return c.text(`hello ${s.uid}`);
    });
  },
  Object.fromEntries(
    ["GET", ...MUTATIONS].map((m) => [`${m} /s`, { session: "test" }]),
  ),
);

const req = (
  init: RequestInit & { url?: string } = {},
  e: Env = base,
): Promise<Response> =>
  Promise.resolve(app.request(init.url ?? `${ORIGIN}/s`, init, e));

const cookieFor = async (value?: string) =>
  `${sessionCookieName(base)}=${value ?? (await signSession(base))}`;

const expectNoStore = (r: Response) =>
  expect(r.headers.get("cache-control")).toBe("no-store");

async function expectRefused(r: Response, code: "unauthorized" | "csrf") {
  expect(r.status).toBe(STATUS_FOR[code]);
  expectNoStore(r);
  const { error } = (await r.json()) as ErrorBody;
  expect(error.code).toBe(code);
  if (code === "unauthorized")
    expect(error.message).toBe("Sign in to continue");
}

describe("gate: {session} rows", () => {
  it("a valid session reaches the handler with c.get('session') set", async () => {
    ran = 0;
    seen.length = 0;
    const r = await req({ headers: { cookie: await cookieFor() } });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(`hello ${OWNER_UID}`);
    expect(ran).toBe(1);
    const s = seen[0] as Session;
    expect(s.uid).toBe(OWNER_UID);
    expect(s.env).toBe(base.ENVIRONMENT);
    expect(s.host).toBe(base.APP_HOST);
    expect(s.gen).toBe(await sessionGeneration(base));
  });

  const cases: [string, () => Promise<string | undefined>][] = [
    ["no cookie", async () => undefined],
    ["garbage", async () => "nope"],
    [
      "a forged signature",
      async () => {
        const v = await signSession(base);
        return `${v.slice(0, -2)}${v.endsWith("AA") ? "BB" : "AA"}`;
      },
    ],
    [
      "another secret",
      async () =>
        signSession({
          ...base,
          SESSION_SECRET: "another-session-secret-0123456789abcdef",
        }),
    ],
    [
      "an expired session",
      async () =>
        signSession(
          base,
          OWNER_UID,
          Date.now() - maxAge.MAX_AGE_S * 1000 - 1000,
        ),
    ],
    [
      "another environment",
      async () => signSession({ ...base, ENVIRONMENT: "production" }),
    ],
    [
      "another host",
      async () => signSession({ ...base, APP_HOST: "other.localhost" }),
    ],
    [
      "another owner",
      async () => signSession({ ...base, OWNER_EMAIL: "someone@example.com" }),
    ],
    [
      "a stale generation",
      async () =>
        signSession(
          base,
          OWNER_UID,
          Date.now(),
          (await sessionGeneration(base)) + 1,
        ),
    ],
  ];
  for (const [name, mk] of cases)
    for (const method of ["GET", "POST"])
      it(`${method} with ${name} is 401 before the handler`, async () => {
        ran = 0;
        const v = await mk();
        const headers: Record<string, string> = {
          [CSRF_HEADER]: "1",
          origin: ORIGIN,
        };
        if (v !== undefined) headers.cookie = `${sessionCookieName(base)}=${v}`;
        const r = await req({ method, headers });
        await expectRefused(r, "unauthorized");
        expect(ran).toBe(0);
      });

  it("a hub error while reading the session fails closed with 401", async () => {
    ran = 0;
    const r = await req(
      { headers: { cookie: await cookieFor() } },
      { ...base, HUB: downHub() },
    );
    await expectRefused(r, "unauthorized");
    expect(ran).toBe(0);
  });

  it("the 401 carries the security headers", async () => {
    const r = await req();
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("CSRF and same-origin on session mutations", () => {
  const ok = async (h: Record<string, string>) => ({
    cookie: await cookieFor(),
    ...h,
  });

  for (const method of MUTATIONS) {
    it(`${method} without ${CSRF_HEADER} is 403 csrf`, async () => {
      ran = 0;
      await expectRefused(
        await req({ method, headers: await ok({ origin: ORIGIN }) }),
        "csrf",
      );
      expect(ran).toBe(0);
    });

    it(`${method} with ${CSRF_HEADER} other than 1 is 403`, async () => {
      await expectRefused(
        await req({
          method,
          headers: await ok({ origin: ORIGIN, [CSRF_HEADER]: "true" }),
        }),
        "csrf",
      );
    });

    for (const h of [
      {},
      { origin: "https://evil.test" },
      { origin: "null" },
      { origin: `http://${base.APP_HOST}` },
      { origin: `${ORIGIN}.evil.test` },
      { origin: "https://evil.test", "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "none" },
    ] as Record<string, string>[])
      it(`${method} with the header but ${JSON.stringify(h)} is 403`, async () => {
        ran = 0;
        await expectRefused(
          await req({
            method,
            headers: await ok({ [CSRF_HEADER]: "1", ...h }),
          }),
          "csrf",
        );
        expect(ran).toBe(0);
      });

    for (const h of [
      { origin: ORIGIN },
      { "sec-fetch-site": "same-origin" },
      { origin: ORIGIN, "sec-fetch-site": "same-origin" },
    ] as Record<string, string>[])
      it(`${method} with the header and ${JSON.stringify(h)} passes`, async () => {
        ran = 0;
        const r = await req({
          method,
          headers: await ok({ [CSRF_HEADER]: "1", ...h }),
        });
        expect(r.status).toBe(200);
        expect(ran).toBe(1);
      });
  }

  it("the csrf code maps to 403 in STATUS_FOR", () => {
    expect(STATUS_FOR.csrf).toBe(403);
  });

  it("dev on a loopback host accepts that host's own http origin", async () => {
    const r = await req({
      url: "http://localhost/s",
      method: "POST",
      headers: await ok({ [CSRF_HEADER]: "1", origin: "http://localhost" }),
    });
    expect(r.status).toBe(200);
  });

  it("outside dev the loopback http origin is refused", async () => {
    const prod = { ...base, ENVIRONMENT: "production" } as Env;
    const v = await signSession(prod);
    const r = await req(
      {
        url: "http://localhost/s",
        method: "POST",
        headers: {
          cookie: `${sessionCookieName(prod)}=${v}`,
          [CSRF_HEADER]: "1",
          origin: "http://localhost",
        },
      },
      prod,
    );
    await expectRefused(r, "csrf");
  });

  it("a mutation without a session is 401, not 403", async () => {
    await expectRefused(await req({ method: "POST" }), "unauthorized");
  });

  it("GET and HEAD need no CSRF header and no Origin", async () => {
    const cookie = await cookieFor();
    expect((await req({ headers: { cookie } })).status).toBe(200);
    expect((await req({ method: "HEAD", headers: { cookie } })).status).toBe(
      200,
    );
  });
});

describe("CSRF exempts only GET and HEAD", () => {
  /** An `ALL` {session} route answers every method, so every method is checked. */
  const all = createApp(
    (a) => {
      a.all("/x", (c) => {
        ran++;
        return c.text("ran");
      });
    },
    { "ALL /x": { session: "test" } },
  );
  for (const method of ["PROPFIND", "PURGE", "OPTIONS"])
    it(`${method} on an ALL session route with an evil Origin and no header is 403`, async () => {
      ran = 0;
      const r = await all.request(
        `${ORIGIN}/x`,
        {
          method,
          headers: { cookie: await cookieFor(), origin: "https://evil.test" },
        },
        base,
      );
      await expectRefused(r, "csrf");
      expect(ran).toBe(0);
    });

  it("PROPFIND with the header and the app Origin passes", async () => {
    ran = 0;
    const r = await all.request(
      `${ORIGIN}/x`,
      {
        method: "PROPFIND",
        headers: {
          cookie: await cookieFor(),
          origin: ORIGIN,
          [CSRF_HEADER]: "1",
        },
      },
      base,
    );
    expect(r.status).toBe(200);
    expect(ran).toBe(1);
  });
});

describe("routes", () => {
  it("logout stays a {public} row", () => {
    expect(ROUTE_POLICY["POST /auth/logout"]).toHaveProperty("public");
  });

  it("logout with a forged cookie is still 204 and clears the cookie", async () => {
    const r = await SELF.fetch(`${ORIGIN}/auth/logout`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie: `${sessionCookieName(base)}=forged.value`,
      },
    });
    expect(r.status).toBe(204);
    expect(
      r.headers
        .getSetCookie()
        .some((c) => c.startsWith(`${sessionCookieName(base)}=;`)),
    ).toBe(true);
  });

  for (const [method, path] of [
    ["GET", "/approve/ABCD-EFGH"],
    ["POST", "/approve/ABCD-EFGH"],
    ["GET", "/api/v1/me"],
    ["GET", "/api/v1/machines"],
    ["DELETE", "/api/v1/machines/m1"],
    ["GET", "/api/v1/agents"],
  ] as const)
    it(`${method} ${path} with a valid session still 404s (no handler yet)`, async () => {
      const r = await SELF.fetch(`${ORIGIN}${path}`, {
        method,
        headers: {
          cookie: await cookieFor(),
          origin: ORIGIN,
          [CSRF_HEADER]: "1",
        },
      });
      expect(r.status).toBe(404);
    });
});

describe("MAX_AGE_S has one definition", () => {
  it("session.ts no longer defines or exports its own", () => {
    expect("MAX_AGE_S" in sessionModule).toBe(false);
  });

  it("the cookie Max-Age and the payload expiry use auth/max-age.ts", async () => {
    expect(sessionCookie("v", base)).toContain(`Max-Age=${maxAge.MAX_AGE_S}`);
    const now = 1_000_000;
    const v = await signSession(base, OWNER_UID, now, 0);
    const s = JSON.parse(
      atob((v.split(".")[0] as string).replace(/-/g, "+").replace(/_/g, "/")),
    ) as Session;
    expect(s.exp - now).toBe(maxAge.MAX_AGE_S * 1000);
  });
});

describe("cross-PR: a real logout closes an open dashboard socket with 4401", () => {
  it("204, then 4401 on the socket, then the old cookie is 401", async () => {
    const gen = await sessionGeneration(base);
    const value = await signSession(base, OWNER_UID, Date.now(), gen);
    const cookie = `${sessionCookieName(base)}=${value}`;
    expect(await readSession(base, value)).not.toBeNull();

    const res = await hubFetch(base, EVENTS_DO_PATH, {
      headers: {
        Upgrade: "websocket",
        [SESSION_EXP_HEADER]: String(Date.now() + 3_600_000),
        [SESSION_GEN_HEADER]: String(gen),
      },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    ws.accept();
    const closed = new Promise<{ code: number }>((resolve) =>
      ws.addEventListener("close", (ev) => resolve({ code: ev.code })),
    );

    const out = await SELF.fetch(`${ORIGIN}/auth/logout`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN },
    });
    expect(out.status).toBe(204);

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("socket never closed")), 10_000),
    );
    expect((await Promise.race([closed, timeout])).code).toBe(4401);

    expect(await hub(base).sessionGeneration()).toBe(gen + 1);
    await expectRefused(await req({ headers: { cookie } }), "unauthorized");
  });
});
