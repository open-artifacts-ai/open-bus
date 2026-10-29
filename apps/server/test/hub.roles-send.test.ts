// AC2a-2: a send to a role resolves to its holder; the new wire (to_name,
// role_vacant, roster role) is gated on AGENT_CARD_MIN_CLIENT.
import {
  AGENT_CARD_MIN_CLIENT,
  type ClientFrame,
  OWNER_ORG_ID,
  PONG,
} from "@ob/shared";
import { describe, expect, it } from "vitest";
import { setRole } from "../src/hub/roles.js";
import {
  type Daemon,
  daemon,
  inOwnerHub,
  machine,
  ns,
  up,
  waitFor,
} from "./helpers.js";

let seq = 0;
const id = (t: string) => `${t}${++seq}`;

async function at(version: string): Promise<Daemon> {
  const d = await daemon((await machine()).token);
  d.send({
    v: 1,
    id: id("h"),
    type: "hello",
    machine_label: "M",
    client_version: version,
  });
  await waitFor(d, "hello_ok");
  return d;
}

async function register(
  d: Daemon,
  ref: string,
  name: string,
  namespace: string,
  global = false,
): Promise<string> {
  d.send(up(id("u"), ref, name, namespace, global));
  const ok = await waitFor(d, "agent_ok");
  expect(ok.bus_name).toBe(name);
  return inOwnerHub(
    (s) =>
      s.storage.sql
        .exec<{ id: string }>(
          "select id from agents where native_ref = ? and live = 1 and name = ? and namespace = ?",
          ref,
          name,
          namespace,
        )
        .one().id,
  );
}

const set = async (namespace: string, role: string, agent: string) =>
  expect(
    await inOwnerHub((s) =>
      setRole(s.storage.sql, namespace, role, agent, Date.now()),
    ),
  ).toBe("ok");

const sendFrame = (
  from_ref: string,
  to_name: string,
  to_namespace?: string,
  fid = id("s"),
): ClientFrame => ({
  v: 1,
  id: fid,
  type: "send",
  from_ref,
  to_name,
  ...(to_namespace === undefined ? {} : { to_namespace }),
  body: "hi",
});

/** The receipt answering frame `fid`, and its raw text. */
async function receiptFor(d: Daemon, fid: string) {
  for (;;) {
    const r = await waitFor(d, "receipt");
    if (r.id !== fid) continue;
    const raw = d.raw.find(
      (t) => t !== PONG && t.includes('"receipt"') && t.includes(`"${fid}"`),
    ) as string;
    return { r, raw: JSON.parse(raw) as Record<string, unknown> };
  }
}

async function send(
  d: Daemon,
  from: string,
  to: string,
  toNs?: string,
  fid = id("s"),
) {
  d.send(sendFrame(from, to, toNs, fid));
  return receiptFor(d, fid);
}

const closeAll = (...ds: Daemon[]) => {
  for (const d of ds)
    try {
      d.close();
    } catch {
      // Already closed.
    }
};

describe("send to a role", () => {
  it("delivers to the live holder; the gated receipt names it", async () => {
    const d = await at(AGENT_CARD_MIN_CLIENT);
    const old = await at("0.53.0");
    try {
      const a = ns("rs");
      const h = await register(d, "r-h", "Holder", a);
      await register(d, "r-s", "Sender", a);
      await register(old, "r-o", "Oldie", a);
      await set(a, "lane-6", h);

      const { r } = await send(d, "r-s", "LANE-6");
      expect(r).toMatchObject({ state: "pending", to_name: "Holder" });
      const del = await waitFor(d, "deliver");
      expect(del).toMatchObject({ msg_id: r.msg_id, to_ref: "r-h" });

      // Below the gate the receipt is unchanged, but the send resolves.
      const o = await send(old, "r-o", "lane-6");
      expect(o.r.state).toBe("pending");
      expect("to_name" in o.raw).toBe(false);

      // B14 resend: the same frame id answers the original receipt, gated.
      const fid = id("s");
      const first = await send(d, "r-s", "lane-6", undefined, fid);
      const again = await send(d, "r-s", "lane-6", undefined, fid);
      expect(again.r).toMatchObject({
        msg_id: first.r.msg_id,
        to_name: "Holder",
      });
      const ofid = id("s");
      await send(old, "r-o", "lane-6", undefined, ofid);
      d.raw.length = 0;
      old.raw.length = 0;
      const oagain = await send(old, "r-o", "lane-6", undefined, ofid);
      expect("to_name" in oagain.raw).toBe(false);
    } finally {
      closeAll(d, old);
    }
  });

  it("queues for a holder whose machine is disconnected", async () => {
    const hm = await at(AGENT_CARD_MIN_CLIENT);
    const d = await at(AGENT_CARD_MIN_CLIENT);
    try {
      const a = ns("rq");
      const h = await register(hm, "r-h", "Holder", a);
      await register(d, "r-s", "Sender", a);
      await set(a, "lane-6", h);
      hm.close();
      await hm.closed;
      const { r } = await send(d, "r-s", "lane-6");
      expect(r).toMatchObject({ state: "pending", to_name: "Holder" });
      const stored = await inOwnerHub(
        (s) =>
          s.storage.sql
            .exec(
              "select 1 from mail where id = ? and to_agent = ?",
              r.msg_id,
              h,
            )
            .toArray().length,
      );
      expect(stored).toBe(1);
    } finally {
      closeAll(hm, d);
    }
  });

  it("refuses a vacant role role_vacant, unknown_agent below the gate", async () => {
    const d = await at(AGENT_CARD_MIN_CLIENT);
    const old = await at("0.53.0");
    try {
      const a = ns("rvac");
      const h = await register(d, "r-h", "Holder", a);
      await register(d, "r-s", "Sender", a);
      await register(old, "r-o", "Oldie", a);
      await set(a, "lane-6", h);
      d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "r-h" });
      const { r, raw } = await send(d, "r-s", "lane-6");
      expect(r).toMatchObject({ state: "refused", reason: "role_vacant" });
      expect("to_name" in raw).toBe(false);
      const o = await send(old, "r-o", "lane-6");
      expect(o.r).toMatchObject({ state: "refused", reason: "unknown_agent" });
    } finally {
      closeAll(d, old);
    }
  });

  it("re-pointing the role delivers to the new holder", async () => {
    const d = await at(AGENT_CARD_MIN_CLIENT);
    try {
      const a = ns("rp");
      const h1 = await register(d, "r-1", "One", a);
      const h2 = await register(d, "r-2", "Two", a);
      await register(d, "r-s", "Sender", a);
      await set(a, "lane-6", h1);
      expect((await send(d, "r-s", "lane-6")).r.to_name).toBe("One");
      await set(a, "lane-6", h2);
      const { r } = await send(d, "r-s", "lane-6");
      expect(r.to_name).toBe("Two");
      for (;;) {
        const del = await waitFor(d, "deliver");
        if (del.msg_id !== r.msg_id) continue;
        expect(del.to_ref).toBe("r-2");
        break;
      }
    } finally {
      closeAll(d);
    }
  });

  it("scopes roles like names: ambiguous, to_namespace, other_namespace", async () => {
    const d = await at(AGENT_CARD_MIN_CLIENT);
    try {
      const a = ns("ra");
      const b = ns("rb");
      const role = id("lane-");
      await set(a, role, await register(d, "r-a", "InA", a));
      await set(b, role, await register(d, "r-b", "InB", b));
      await register(d, "r-g", id("Glob"), ns("home"), true);
      await register(d, "r-n", "Local", a);

      expect((await send(d, "r-g", role)).r).toMatchObject({
        state: "refused",
        reason: "ambiguous",
      });
      expect((await send(d, "r-g", role, b)).r.to_name).toBe("InB");
      // A non-global sender sees its own namespace's role only.
      expect((await send(d, "r-n", role)).r.to_name).toBe("InA");
      expect((await send(d, "r-n", role, b)).r).toMatchObject({
        state: "refused",
        reason: "other_namespace",
      });
    } finally {
      closeAll(d);
    }
  });

  it("a global sender: a role in one namespace and a name in another is ambiguous", async () => {
    const d = await at(AGENT_CARD_MIN_CLIENT);
    try {
      const a = ns("rx");
      const b = ns("ry");
      const role = id("lane-");
      await set(a, role, await register(d, "r-a", "InA", a));
      await register(d, "r-b", role, b);
      await register(d, "r-g", id("Glob"), ns("home"), true);
      expect((await send(d, "r-g", role)).r.reason).toBe("ambiguous");
      expect((await send(d, "r-g", role, a)).r.to_name).toBe("InA");
      expect((await send(d, "r-g", role, b)).r.to_name).toBe(role);
    } finally {
      closeAll(d);
    }
  });
});

describe("roster role", () => {
  it("a gated roster row shows role; a 0.53.0 roster has none", async () => {
    const d = await at(AGENT_CARD_MIN_CLIENT);
    const old = await at("0.53.0");
    try {
      const a = ns("rr");
      await set(a, "lane-6", await register(d, "r-h", "Holder", a));
      await register(old, "r-o", "Oldie", a);
      const lid = id("l");
      d.send({ v: 1, id: lid, type: "list", from_ref: "r-h" });
      let ros = await waitFor(d, "roster");
      while (ros.id !== lid) ros = await waitFor(d, "roster");
      expect(ros.agents.find((r) => r.bus_name === "Holder")?.role).toBe(
        "lane-6",
      );
      expect(ros.agents.find((r) => r.bus_name === "Oldie")?.role).toBe(
        undefined,
      );
      const oid = id("l");
      old.send({ v: 1, id: oid, type: "list", from_ref: "r-o" });
      let ro = await waitFor(old, "roster");
      while (ro.id !== oid) ro = await waitFor(old, "roster");
      expect(ro.agents.map((r) => r.bus_name)).toContain("Holder");
      const raw = old.raw.find((t) => t.includes(`"${oid}"`)) as string;
      expect(raw).not.toContain('"role"');
    } finally {
      closeAll(d, old);
    }
  });
});

describe("no client frame sets a role", () => {
  it("{type:'role'} is bad_frame", async () => {
    const d = await at(AGENT_CARD_MIN_CLIENT);
    try {
      const a = ns("rf");
      await register(d, "r-h", "Holder", a);
      d.ws.send(
        JSON.stringify({
          v: 1,
          id: "x1",
          type: "role",
          from_ref: "r-h",
          role: "lane-6",
        }),
      );
      expect(await waitFor(d, "error")).toMatchObject({ code: "bad_frame" });
      const n = await inOwnerHub(
        (s) =>
          s.storage.sql
            .exec(
              "select 1 from roles where org_id = ? and namespace = ?",
              OWNER_ORG_ID,
              a,
            )
            .toArray().length,
      );
      expect(n).toBe(0);
    } finally {
      closeAll(d);
    }
  });
});
