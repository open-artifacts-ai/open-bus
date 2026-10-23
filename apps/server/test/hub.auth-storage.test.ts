import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { OWNER_ORG_ID } from "@ob/shared";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import type { Hub, HubStub } from "../src/hub/do.js";

const e = env as unknown as Env;
const freshHub = (): HubStub =>
  e.HUB.get(e.HUB.newUniqueId()) as unknown as HubStub;

const states = (h: HubStub) =>
  runInDurableObject(h as unknown as DurableObjectStub<Hub>, (_: Hub, s) =>
    s.storage.sql
      .exec<{ state: string; org_id: string }>(
        "select state, org_id from oidc_states order by state",
      )
      .toArray(),
  );

const HOUR = 3_600_000;

describe("hub auth storage: OIDC states", () => {
  it("accepts a state once and refuses every reuse", async () => {
    const h = freshHub();
    const exp = Date.now() + 600_000;
    expect(await h.consumeState("state-a", exp)).toBe(true);
    expect(await h.consumeState("state-a", exp)).toBe(false);
    expect(await h.consumeState("state-b", exp)).toBe(true);
    expect(await h.consumeState("state-a", exp)).toBe(false);
    expect(await h.consumeState("state-b", exp)).toBe(false);
    expect(await states(h)).toEqual([
      { state: "state-a", org_id: OWNER_ORG_ID },
      { state: "state-b", org_id: OWNER_ORG_ID },
    ]);
  });

  it("treats a state with SQL metacharacters as an opaque string", async () => {
    const h = freshHub();
    const evil = "x'); drop table oidc_states; --";
    expect(await h.consumeState(evil, Date.now() + 1000)).toBe(true);
    expect(await h.consumeState(evil, Date.now() + 1000)).toBe(false);
    expect((await states(h)).map((r) => r.state)).toEqual([evil]);
  });

  it("purges rows that expired more than an hour ago", async () => {
    const h = freshHub();
    const t0 = 1_800_000_000_000;
    await h.setClock(t0);
    expect(await h.consumeState("old", t0 + 1000)).toBe(true);
    expect(await h.consumeState("recent", t0 + HOUR)).toBe(true);
    await h.setClock(t0 + 1000 + HOUR + 1);
    expect(await h.consumeState("new", t0 + 2 * HOUR)).toBe(true);
    expect((await states(h)).map((r) => r.state)).toEqual(["new", "recent"]);
  });
});

describe("hub auth storage: session generation", () => {
  it("starts at 0 and bumps to 1, then 2", async () => {
    const h = freshHub();
    expect(await h.sessionGeneration()).toBe(0);
    expect(await h.bumpSessionGeneration()).toBe(1);
    expect(await h.sessionGeneration()).toBe(1);
    expect(await h.bumpSessionGeneration()).toBe(2);
    expect(await h.sessionGeneration()).toBe(2);
  });
});
