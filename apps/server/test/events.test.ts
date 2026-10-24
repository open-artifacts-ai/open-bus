import {
  ApiErrorSchema,
  type BusEvent,
  BusEventSchema,
  newId,
  R,
} from "@ob/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mw } from "../src/auth/route-policy.js";
import { mountRoutes } from "../src/routes/index.js";
import { e, inOwnerHub } from "./helpers.js";

// B2b's session middleware is not on this branch: a test-only middleware sets
// the `session` variable and the row is opened (public) for the handler to run.
// The real owner hub is used, so every stream is cancelled before the test ends.

const OWNER = { uid: "owner", email: "owner@example.com", name: null };
const OPEN = { "GET /api/v1/events": { public: "test" } };
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

function appWith(session: unknown) {
  return createApp((app) => {
    if (session !== undefined)
      app.use(
        "/api/*",
        mw(async (c, next) => {
          (c as unknown as { set(k: string, v: unknown): void }).set(
            "session",
            session,
          );
          await next();
        }),
      );
    mountRoutes(app);
  }, OPEN);
}

const OBSERVER = "observer";
const OPEN_STATE = 1;

/** Open observer sockets on the owner hub (the hub side of each bridge). */
const openObservers = () =>
  inOwnerHub(
    (s) =>
      s.getWebSockets(OBSERVER).filter((w) => w.readyState === OPEN_STATE)
        .length,
  );

/** Sends raw text from the hub to every observer socket. */
const hubSend = (...texts: string[]) =>
  inOwnerHub((s) => {
    for (const w of s.getWebSockets(OBSERVER))
      if (w.readyState === OPEN_STATE) for (const t of texts) w.send(t);
  });

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function until(f: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await f()) return;
    await tick(10);
  }
  throw new Error(`timed out: ${what}`);
}

const TIMEOUT = Symbol("timeout");
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<typeof TIMEOUT>((r) => {
      t = setTimeout(() => r(TIMEOUT), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

type Stream = {
  res: Response;
  /** Next frame, exactly `data: <json>\n\n`; null when the stream ended. */
  next: (ms?: number) => Promise<BusEvent | null>;
  /** Raw text of every frame read. */
  raw: string[];
  cancel: () => Promise<void>;
};

const streams: Stream[] = [];
afterEach(async () => {
  for (const s of streams.splice(0)) await s.cancel();
});

async function open(signal?: AbortSignal): Promise<Stream> {
  const res = await appWith(OWNER).fetch(
    new Request(`https://app.localhost${R.events}`, {
      headers: { accept: "text/event-stream" },
      signal,
    }),
    e,
    ctx,
  );
  expect(res.status).toBe(200);
  const body = res.body;
  if (!body) throw new Error("no body");
  const reader = body.getReader();
  const dec = new TextDecoder();
  const raw: string[] = [];
  let buf = "";
  let read: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const next = async (ms = 3000): Promise<BusEvent | null> => {
    for (;;) {
      const i = buf.indexOf("\n\n");
      if (i >= 0) {
        const f = buf.slice(0, i + 2);
        buf = buf.slice(i + 2);
        raw.push(f);
        const json = f.slice("data: ".length, -2);
        const ev = BusEventSchema.parse(JSON.parse(json));
        // Exactly one data line, no event: line, nothing else.
        expect(f).toBe(`data: ${JSON.stringify(ev)}\n\n`);
        return ev;
      }
      read ??= reader.read();
      const r = await within(read, ms);
      if (r === TIMEOUT) throw new Error("timed out waiting for a frame");
      read = null;
      if (r.done) return null;
      buf += dec.decode(r.value, { stream: true });
    }
  };
  let cancelled = false;
  const s: Stream = {
    res,
    next,
    raw,
    cancel: async () => {
      if (cancelled) return;
      cancelled = true;
      await reader.cancel().catch(() => {});
    },
  };
  streams.push(s);
  return s;
}

/** The three connect frames, in the order they arrive. */
async function snapshot(s: Stream) {
  return [await s.next(), await s.next(), await s.next()];
}

const marker = () => ({
  type: "machines" as const,
  machines: [
    {
      id: newId(),
      label: `marker-${newId()}`,
      createdAt: "2026-10-24T00:00:00.000Z",
      lastUsed: null,
      revokedAt: null,
      connected: false,
    },
  ],
});

describe("GET /api/v1/events", () => {
  it("401s without a session and never opens a hub socket", async () => {
    const before = await openObservers();
    const r = await appWith(undefined).fetch(
      new Request(`https://app.localhost${R.events}`),
      e,
      ctx,
    );
    expect(r.status).toBe(401);
    expect(ApiErrorSchema.parse(await r.json()).error.code).toBe(
      "unauthorized",
    );
    expect(await openObservers()).toBe(before);
  });

  it("streams SSE headers and the hub's hello, machines, agents in order", async () => {
    const s = await open();
    expect(s.res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(s.res.headers.get("cache-control")).toBe("no-cache");
    expect(s.res.headers.get("content-encoding")).toBeNull();
    const [a, b, c] = await snapshot(s);
    expect(a).toEqual({ type: "hello" });
    expect(b?.type).toBe("machines");
    expect(c?.type).toBe("agents");
    for (const f of s.raw) expect(f).not.toMatch(/^event:/m);
  });

  it("forwards valid hub frames and drops invalid ones", async () => {
    const s = await open();
    await snapshot(s);
    const m = marker();
    await hubSend(
      "not json",
      JSON.stringify({ type: "bogus" }),
      JSON.stringify({ type: "machines", machines: "nope" }),
      JSON.stringify({ type: "hello", extra: 1 }),
      JSON.stringify(m),
    );
    // Real pushes may interleave; every frame read must be valid (next()
    // parses each one), and the invalid ones never appear.
    for (;;) {
      const ev = await s.next();
      if (ev === null) throw new Error("stream ended");
      if (
        ev.type === "machines" &&
        ev.machines[0]?.label === m.machines[0]?.label
      )
        break;
    }
    expect(s.raw.join("")).not.toMatch(/bogus|nope|extra|not json/);
  });

  it("closes the hub socket when the client cancels the stream", async () => {
    const before = await openObservers();
    const s = await open();
    await snapshot(s);
    expect(await openObservers()).toBe(before + 1);
    await s.cancel();
    await until(async () => (await openObservers()) === before, "hub close");
  });

  it("closes the hub socket when the request is aborted", async () => {
    const before = await openObservers();
    const ac = new AbortController();
    const s = await open(ac.signal);
    await snapshot(s);
    expect(await openObservers()).toBe(before + 1);
    ac.abort();
    await until(async () => (await openObservers()) === before, "hub close");
  });

  it("ends the stream when the hub closes the socket", async () => {
    const s = await open();
    await snapshot(s);
    await inOwnerHub((st) => {
      for (const w of st.getWebSockets(OBSERVER)) w.close(1000, "bye");
    });
    expect(await s.next()).toBeNull();
  });

  it("ends the stream when the hub evicts the observer (1013)", async () => {
    const first = await open();
    await snapshot(first);
    // MAX_OBSERVERS is 16: sixteen newer observers evict the oldest one.
    for (let i = 0; i < 16; i++) await snapshot(await open());
    expect(await first.next()).toBeNull();
  });

  it("keeps only the latest machines and agents frame for a slow reader", async () => {
    const s = await open();
    await snapshot(s);
    const texts: string[] = [];
    let last = marker();
    for (let i = 0; i < 50; i++) {
      last = marker();
      texts.push(JSON.stringify(last));
      texts.push(JSON.stringify({ type: "agents", agents: [] }));
    }
    await hubSend(...texts);
    await tick(100);
    const got: BusEvent[] = [];
    for (;;) {
      const ev = await s.next(300).catch(() => null);
      if (ev === null) break;
      got.push(ev);
    }
    // Real pushes may add at most one of each type; never the 100 injected.
    expect(got.length).toBeLessThanOrEqual(2);
    const machines = got.find((x) => x.type === "machines");
    expect(machines).toEqual(last);
    expect(got.some((x) => x.type === "agents")).toBe(true);
  });
});
