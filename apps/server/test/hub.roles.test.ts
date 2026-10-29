// AC2a-1: the roles table, its collisions with agent names, and vacate on close.
import { LIMITS, newId, OWNER_ORG_ID } from "@ob/shared";
import { describe, expect, it } from "vitest";
import {
  deleteRole,
  listRoles,
  roleTaken,
  setRole,
  vacateRoles,
} from "../src/hub/roles.js";
import { hub } from "../src/hub/stub.js";
import {
  type Daemon,
  e,
  inOwnerHub,
  machine,
  ns,
  ready,
  up,
  waitFor,
} from "./helpers.js";

let seq = 0;
const id = (t: string) => `${t}${++seq}`;

async function register(
  d: Daemon,
  ref: string,
  name: string,
  namespace: string,
  global = false,
): Promise<string> {
  d.send(up(id("u"), ref, name, namespace, global));
  return (await waitFor(d, "agent_ok")).bus_name;
}

/** A hello round trip, so every frame sent before it has been processed. */
async function roundTrip(d: Daemon): Promise<void> {
  const h = id("h");
  d.send({
    v: 1,
    id: h,
    type: "hello",
    machine_label: "M",
    client_version: "0.1.0",
  });
  while ((await waitFor(d, "hello_ok")).id !== h);
}

const agentId = (namespace: string, name: string) =>
  inOwnerHub((s) => {
    const r = s.storage.sql
      .exec<{ id: string }>(
        "select id from agents where namespace = ? and name = ?",
        namespace,
        name,
      )
      .toArray()[0];
    if (!r) throw new Error(`no agent ${name}`);
    return r.id;
  });

const set = (namespace: string, role: string, agent: string) =>
  inOwnerHub((s) => setRole(s.storage.sql, namespace, role, agent, Date.now()));

const holder = (namespace: string, role: string) =>
  inOwnerHub(
    (s) =>
      s.storage.sql
        .exec<{ agent_id: string | null }>(
          "select agent_id from roles where namespace = ? and lrole = ?",
          namespace,
          role.toLowerCase(),
        )
        .toArray()[0]?.agent_id,
  );

describe("setRole", () => {
  it("refuses bad_agent for an unknown, closed or other-namespace agent; allows a global", async () => {
    const d = await ready((await machine()).token);
    try {
      const a = ns("ra");
      const b = ns("rb");
      await register(d, "r-a", "Alpha", a);
      await register(d, "r-b", "Bravo", b);
      await register(d, "r-g", id("Gee"), b, true);
      await register(d, "r-c", "Charlie", a);
      const charlie = await agentId(a, "Charlie");
      d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "r-c" });
      await roundTrip(d);

      expect(await set(a, "lane-1", newId())).toBe("bad_agent");
      expect(await set(a, "lane-1", charlie)).toBe("bad_agent");
      expect(await set(a, "lane-1", await agentId(b, "Bravo"))).toBe(
        "bad_agent",
      );
      const g = await inOwnerHub(
        (s) =>
          s.storage.sql
            .exec<{ id: string }>(
              "select id from agents where native_ref = 'r-g' and live = 1 and namespace = ?",
              b,
            )
            .toArray()[0]?.id as string,
      );
      expect(await set(a, "lane-1", g)).toBe("ok");
      expect(await set(a, "lane-0", await agentId(a, "Alpha"))).toBe("ok");
    } finally {
      d.close();
    }
  });

  it("refuses name_taken for a role equal (any case) to an open agent's name", async () => {
    const d = await ready((await machine()).token);
    try {
      const a = ns("rn");
      await register(d, "r-l", "Lane-6", a);
      await register(d, "r-x", "Xray", a);
      const x = await agentId(a, "Xray");
      expect(await set(a, "lane-6", x)).toBe("name_taken");
      expect(await set(a, "LANE-6", x)).toBe("name_taken");
      // A global's name is visible in every namespace.
      const gname = id("glob");
      await register(d, "r-g", gname, ns("other"), true);
      expect(await set(a, gname.toUpperCase(), x)).toBe("name_taken");
    } finally {
      d.close();
    }
  });

  it("holds one role per agent; re-pointing and re-setting are ok", async () => {
    const d = await ready((await machine()).token);
    try {
      const a = ns("r1");
      await register(d, "r-x", "Xray", a);
      await register(d, "r-y", "Yankee", a);
      const x = await agentId(a, "Xray");
      const y = await agentId(a, "Yankee");
      expect(await set(a, "lane-6", x)).toBe("ok");
      expect(await set(a, "LANE-6", x)).toBe("ok");
      expect(await set(a, "lane-7", x)).toBe("agent_has_role");
      expect(await set(a, "lane-6", y)).toBe("ok");
      expect(await holder(a, "lane-6")).toBe(y);
      expect(await set(a, "lane-7", x)).toBe("ok");
      // The display name follows the latest PUT.
      const rows = await inOwnerHub((s) => listRoles(s.storage.sql));
      const r6 = rows.find((r) => r.namespace === a && r.role === "lane-6");
      expect(r6).toMatchObject({ agentId: y, holderName: "Yankee" });
    } finally {
      d.close();
    }
  });

  it("refuses full at LIMITS.maxRoles for a new role, not for a re-point", async () => {
    const d = await ready((await machine()).token);
    const a = ns("rfull");
    const filler = ns("filler");
    try {
      await register(d, "r-x", "Xray", a);
      await register(d, "r-y", "Yankee", a);
      const x = await agentId(a, "Xray");
      const y = await agentId(a, "Yankee");
      expect(await set(a, "lane-1", x)).toBe("ok");
      await inOwnerHub((s) => {
        const sql = s.storage.sql;
        const n = sql
          .exec<{ n: number }>("select count(*) as n from roles")
          .one().n;
        for (let i = n; i < LIMITS.maxRoles; i++)
          sql.exec(
            "insert into roles (org_id, namespace, role, lrole, agent_id, set_at) values (?, ?, ?, ?, null, 0)",
            OWNER_ORG_ID,
            filler,
            `f-${i}`,
            `f-${i}`,
          );
      });
      expect(await set(a, "lane-2", y)).toBe("full");
      expect(await set(a, "lane-1", y)).toBe("ok");
    } finally {
      await inOwnerHub((s) =>
        s.storage.sql.exec("delete from roles where namespace = ?", filler),
      );
      d.close();
    }
  });
});

describe("roles and names", () => {
  it("an agent proposing a role's name (any case) gets a suffix", async () => {
    const d = await ready((await machine()).token);
    try {
      const a = ns("rs");
      await register(d, "r-x", "Xray", a);
      expect(await set(a, "lane-6", await agentId(a, "Xray"))).toBe("ok");
      const got = await register(d, "r-l", "LANE-6", a);
      expect(got.toLowerCase()).toBe("lane-6-2");
      // A vacant role still reserves its name.
      await inOwnerHub((s) => vacateRoles(s.storage.sql, [newId()]));
      const role = id("role");
      await inOwnerHub((s) =>
        s.storage.sql.exec(
          "insert into roles (org_id, namespace, role, lrole, agent_id, set_at) values (?, ?, ?, ?, null, 0)",
          OWNER_ORG_ID,
          a,
          role,
          role.toLowerCase(),
        ),
      );
      expect(await register(d, "r-v", role, a)).toBe(`${role}-2`);
      // A global's name collides with a role in any namespace (and -2 with
      // the agent above); a non-global's only in its own.
      expect(await register(d, "r-g", role, ns("elsewhere"), true)).toBe(
        `${role}-3`,
      );
      expect(await register(d, "r-o", role, ns("elsewhere"))).toBe(role);
      await inOwnerHub((s) => {
        expect(roleTaken(s.storage.sql, a, role.toLowerCase(), false)).toBe(
          true,
        );
        expect(
          roleTaken(s.storage.sql, ns("z"), role.toLowerCase(), true),
        ).toBe(true);
        expect(
          roleTaken(s.storage.sql, ns("z"), role.toLowerCase(), false),
        ).toBe(false);
      });
    } finally {
      d.close();
    }
  });

  it("deleteRole and listRoles", async () => {
    const d = await ready((await machine()).token);
    try {
      const a = ns("rd");
      await register(d, "r-x", "Xray", a);
      expect(await set(a, "Lane-9", await agentId(a, "Xray"))).toBe("ok");
      const rows = await inOwnerHub((s) => listRoles(s.storage.sql));
      expect(rows.find((r) => r.namespace === a)).toMatchObject({
        role: "Lane-9",
        holderName: "Xray",
      });
      expect(
        await inOwnerHub((s) => deleteRole(s.storage.sql, a, "LANE-9")),
      ).toBe(true);
      expect(
        await inOwnerHub((s) => deleteRole(s.storage.sql, a, "lane-9")),
      ).toBe(false);
    } finally {
      d.close();
    }
  });
});

describe("vacate on close (Review Focus 1)", () => {
  for (const how of ["agent_down", "sessions", "revoke"] as const)
    it(`${how} vacates the role; the reopened session does not regain it`, async () => {
      const m = await machine();
      const d = await ready(m.token);
      const a = ns("rv");
      try {
        await register(d, "r-h", "Holder", a);
        const h = await agentId(a, "Holder");
        expect(await set(a, "lane-6", h)).toBe("ok");
        if (how === "agent_down")
          d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "r-h" });
        else if (how === "sessions")
          d.send({
            v: 1,
            id: id("s"),
            type: "sessions",
            open: [],
            closed: ["r-h"],
          });
        else await hub(e).revokeMachine(m.id);
        if (how !== "revoke") {
          await roundTrip(d);
        }
        expect(await holder(a, "lane-6")).toBeNull();
        if (how === "revoke") return;
        // The same machine and native_ref reuse the agent id.
        expect(await register(d, "r-h", "Holder", a)).toBe("Holder");
        expect(await agentId(a, "Holder")).toBe(h);
        expect(await holder(a, "lane-6")).toBeNull();
      } finally {
        try {
          d.close();
        } catch {
          // Already closed (revoked).
        }
      }
    });
});
