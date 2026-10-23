import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { LIMITS, OWNER_ORG_ID } from "@ob/shared";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { Hub, type HubStub } from "../src/hub/do.js";
import { sha256Hex } from "../src/hub/hash.js";
import { HUB_SCHEMA } from "../src/hub/schema.js";
import { hub } from "../src/hub/stub.js";

const e = env as unknown as Env;

/** A hub of its own, so counts and ordering are not shared with other tests. */
const freshHub = (): HubStub =>
  e.HUB.get(e.HUB.newUniqueId()) as unknown as HubStub;

const inHub = <R>(h: HubStub, fn: (i: Hub, s: DurableObjectState) => R) =>
  runInDurableObject(h as unknown as DurableObjectStub<Hub>, (i: Hub, s) =>
    fn(i, s),
  );

/** The clock is instance-only (never RPC): set it inside the DO. */
const setClock = (h: HubStub, ms: number | null) =>
  inHub(h, (i) => Hub.setTestClock(i, ms));

/** `machine(id)` is protected (B9's revoke calls it); tests reach it by key. */
const lookup = (i: Hub, id: string) =>
  // biome-ignore lint/complexity/useLiteralKeys: protected member, reached by key in tests
  i["machine"](id);

const revoke = (h: HubStub, id: string, at = Date.now()) =>
  inHub(h, (_, s) => {
    s.storage.sql.exec(
      "update machines set revoked_at = ? where id = ?",
      at,
      id,
    );
  });

describe("hub machines", () => {
  it("creates a machine, returns a token once and verifies its hash", async () => {
    const h = hub(e);
    const m = await h.createMachine("MacBook");
    expect(m.token).toMatch(/^ob_machine_[1-9A-HJ-NP-Za-km-z]{32}$/);
    expect(m.id).toHaveLength(16);
    expect(await h.verifyToken(await sha256Hex(m.token))).toEqual({
      id: m.id,
      label: "MacBook",
    });
    expect(
      await h.verifyToken(await sha256Hex(`ob_machine_${"a".repeat(32)}`)),
    ).toBeNull();
  });

  it("lists machines with liveness and never the hash", async () => {
    const h = hub(e);
    const m = await h.createMachine("Studio");
    const rows = await h.listMachines();
    const row = rows.find((r) => r.id === m.id);
    expect(row).toMatchObject({
      label: "Studio",
      revokedAt: null,
      lastUsedAt: null,
      connected: false,
    });
    const json = JSON.stringify(rows);
    expect(json).not.toContain("tokenHash");
    expect(json).not.toContain("token_hash");
    expect(json).not.toContain(m.token);
    expect(json).not.toContain(await sha256Hex(m.token));
  });

  it("stamps org_id on every row", async () => {
    const h = hub(e);
    await h.createMachine("Org");
    expect((await h.listMachines()).length).toBeGreaterThan(0);
    const orgs = await inHub(h, (_, s) =>
      s.storage.sql
        .exec<{ org_id: string }>("select distinct org_id from machines")
        .toArray()
        .map((r) => r.org_id),
    );
    expect(orgs).toEqual([OWNER_ORG_ID]);
  });

  it("stores only the token's SHA-256, never the token", async () => {
    const h = freshHub();
    const m = await h.createMachine("Hash");
    const stored = await inHub(
      h,
      (_, s) =>
        s.storage.sql
          .exec<{ token_hash: string }>(
            "select token_hash from machines where id = ?",
            m.id,
          )
          .one().token_hash,
    );
    expect(stored).not.toBe(m.token);
    expect(stored).not.toContain(m.token);
    expect(stored).toBe(await sha256Hex(m.token));
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lists revoked machines with revokedAt set and connected false", async () => {
    const h = freshHub();
    const m = await h.createMachine("Old laptop");
    await revoke(h, m.id, 1_700_000_000_000);
    const row = (await h.listMachines()).find((r) => r.id === m.id);
    expect(row).toMatchObject({
      revokedAt: 1_700_000_000_000,
      connected: false,
    });
    expect(await h.verifyToken(await sha256Hex(m.token))).toBeNull();
  });

  it("machine(id) is null for a revoked or unknown machine", async () => {
    const h = freshHub();
    const live = await h.createMachine("Live");
    const gone = await h.createMachine("Gone");
    await revoke(h, gone.id);
    await inHub(h, (i) => {
      expect(lookup(i, live.id)).toMatchObject({
        id: live.id,
        label: "Live",
        connected: false,
      });
      expect(lookup(i, gone.id)).toBeNull();
      expect(lookup(i, "1111111111111111")).toBeNull();
    });
  });

  it("reports connected from a socket tagged with the machine id, never for a revoked one", async () => {
    const h = freshHub();
    const on = await h.createMachine("On");
    const off = await h.createMachine("Off");
    const cut = await h.createMachine("Cut");
    await inHub(h, (_, s) => {
      for (const id of [on.id, cut.id]) {
        const pair = new WebSocketPair();
        s.acceptWebSocket(pair[1], [id]);
      }
    });
    await revoke(h, cut.id);
    const rows = await h.listMachines();
    const by = (id: string) => rows.find((r) => r.id === id)?.connected;
    expect(by(on.id)).toBe(true);
    expect(by(off.id)).toBe(false);
    expect(by(cut.id)).toBe(false);
    await inHub(h, (i) => {
      expect(lookup(i, on.id)?.connected).toBe(true);
    });
  });

  it("lists newest first, capped at maxMachinesListed", async () => {
    const h = freshHub();
    const t0 = 1_800_000_000_000;
    const ids: string[] = [];
    for (let k = 0; k <= LIMITS.maxMachinesListed; k++) {
      await setClock(h, t0 + k);
      ids.push((await h.createMachine(`m${k}`)).id);
    }
    const rows = await h.listMachines();
    expect(rows).toHaveLength(LIMITS.maxMachinesListed);
    expect(rows[0]?.id).toBe(ids.at(-1));
    expect(rows.map((r) => r.id)).not.toContain(ids[0]);
    const created = rows.map((r) => r.createdAt);
    expect(created).toEqual([...created].sort((a, b) => b - a));
  });

  it.each([
    ["empty", ""],
    ["control character", "Mac\u0007Book"],
    ["bidi override", "Mac‮Book"],
    ["zero-width", "Mac​Book"],
    ["surrounding whitespace", " MacBook "],
    ["over 128 characters", "a".repeat(2 * LIMITS.maxLabelChars + 1)],
  ])("rejects a label with %s", async (_, label) => {
    const h = freshHub();
    // On the instance: over RPC, workerd reports the awaited rejection as unhandled.
    await inHub(h, async (i) => {
      await expect(i.createMachine(label)).rejects.toThrow(
        /invalid machine label/,
      );
    });
    expect(await h.listMachines()).toEqual([]);
  });

  it("accepts a 128-character label", async () => {
    const h = freshHub();
    const label = "a".repeat(2 * LIMITS.maxLabelChars);
    expect((await h.createMachine(label)).label).toBe(label);
  });

  it("throttles last_used to once an hour", async () => {
    const h = freshHub();
    const m = await h.createMachine("Busy");
    const hash = await sha256Hex(m.token);
    const t0 = 1_900_000_000_000;
    await setClock(h, t0);
    await h.verifyToken(hash);
    await setClock(h, t0 + 60_000);
    await h.verifyToken(hash);
    expect((await h.listMachines())[0]?.lastUsedAt).toBe(t0);
    await setClock(h, t0 + 3_600_001);
    await h.verifyToken(hash);
    expect((await h.listMachines())[0]?.lastUsedAt).toBe(t0 + 3_600_001);
  });

  it("keeps the test clock off the RPC surface", async () => {
    // RPC exposes the class's prototype methods; calling a missing one over the
    // stub rejects but workerd also logs it as uncaught, so check the shape.
    const rpc = Object.getOwnPropertyNames(Hub.prototype);
    expect(rpc).not.toContain("setClock");
    expect(rpc).not.toContain("setTestClock");
    expect(typeof Hub.setTestClock).toBe("function");
    await inHub(freshHub(), (i) => {
      expect("setClock" in i).toBe(false);
      expect("setTestClock" in i).toBe(false);
    });
  });

  it("the schema is idempotent", async () => {
    const h = freshHub();
    await h.createMachine("Keep");
    await inHub(h, (_, s) => {
      s.storage.sql.exec(HUB_SCHEMA);
      s.storage.sql.exec(HUB_SCHEMA);
      new Hub(s, e);
    });
    expect((await h.listMachines()).map((r) => r.label)).toEqual(["Keep"]);
  });
});
