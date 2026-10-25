// C23a: daemons built before the omp kind (published 0.44.x) decode `kind`
// strictly, so the hub never sends them an omp roster row. The gate reads
// `hello.client_version` from the socket attachment and fails closed.
import { KIND_TOKEN_MIN_CLIENT, PONG, type ServerFrame } from "@ob/shared";
import { describe, expect, it } from "vitest";
import {
  type Daemon,
  daemon,
  inOwnerHub,
  machine,
  ns,
  up,
  waitFor,
} from "./helpers.js";

type Roster = Extract<ServerFrame, { type: "roster" }>;

let seq = 0;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;

/** A daemon that says hello with `version`, or never says hello. */
async function at(token: string, version: string | null): Promise<Daemon> {
  const d = await daemon(token);
  if (version !== null) {
    d.send({
      v: 1,
      id: `h${++seq}`,
      type: "hello",
      machine_label: "MacBook",
      client_version: version,
    });
    await waitFor(d, "hello_ok");
  }
  return d;
}

async function agent(
  d: Daemon,
  ref: string,
  name: string,
  namespace: string,
  opts: { kind?: "omp"; global?: boolean } = {},
): Promise<void> {
  const f = up(`u-${ref}-${++seq}`, ref, name, namespace, opts.global);
  if (f.type !== "agent_up") throw new Error("up builds an agent_up");
  d.send(opts.kind ? { ...f, kind: opts.kind } : f);
  expect((await waitFor(d, "agent_ok")).bus_name).toBe(name);
}

async function list(d: Daemon, from_ref: string): Promise<Roster> {
  const id = `l${++seq}`;
  d.send({ v: 1, id, type: "list", from_ref });
  for (;;) {
    const r = await waitFor(d, "roster");
    if (r.id === id) return r;
  }
}

/** No frame the daemon received ever named the omp kind. */
const neverSawOmp = (d: Daemon) =>
  expect(d.raw.filter((t) => t !== PONG && t.includes('"omp"'))).toEqual([]);

const closeAll = (ds: Daemon[]) => {
  for (const d of ds)
    try {
      d.close();
    } catch {
      // Already closed.
    }
};

/**
 * An omp agent (local, plus a global one) and an opencode agent in one
 * namespace, then `observer` registers its own local and global agents there.
 */
async function scene(observerVersion: string | null) {
  const host = await at(
    (await machine(uniq("Omp host"))).token,
    KIND_TOKEN_MIN_CLIENT,
  );
  const obs = await at(
    (await machine(uniq("Observer"))).token,
    observerVersion,
  );
  const n = ns("omp");
  const names = {
    omp: uniq("omp"),
    ompGlobal: uniq("ompg"),
    other: uniq("oc"),
    self: uniq("self"),
    selfGlobal: uniq("selfg"),
  };
  await agent(host, "r-omp", names.omp, n, { kind: "omp" });
  await agent(host, "r-ompg", names.ompGlobal, n, {
    kind: "omp",
    global: true,
  });
  await agent(host, "r-oc", names.other, n);
  await agent(obs, "r-self", names.self, n);
  await agent(obs, "r-selfg", names.selfGlobal, n, { global: true });
  return { host, obs, names, n };
}

describe("omp roster gate", () => {
  for (const v of [
    "0.44.1",
    "0.44.0",
    `${KIND_TOKEN_MIN_CLIENT}-rc.1`,
    "0.0.0",
    "garbage",
    null,
  ]) {
    it(`hides omp rows from a daemon at ${v ?? "no hello"}`, async () => {
      const { host, obs, names } = await scene(v);
      try {
        for (const from of ["r-self", "r-selfg"]) {
          const got = (await list(obs, from)).agents.map((a) => a.bus_name);
          expect(got).toContain(names.other);
          expect(got).toContain(names.self);
          expect(got).not.toContain(names.omp);
          expect(got).not.toContain(names.ompGlobal);
        }
        neverSawOmp(obs);
      } finally {
        closeAll([host, obs]);
      }
    });
  }

  for (const v of [
    KIND_TOKEN_MIN_CLIENT,
    `${KIND_TOKEN_MIN_CLIENT}+build.1`,
    "99.0.0",
  ]) {
    it(`shows omp rows to a daemon at ${v}`, async () => {
      const { host, obs, names } = await scene(v);
      try {
        for (const from of ["r-self", "r-selfg"]) {
          const r = (await list(obs, from)).agents;
          const kind = (n: string) => r.find((a) => a.bus_name === n)?.kind;
          expect(kind(names.omp)).toBe("omp");
          expect(kind(names.ompGlobal)).toBe("omp");
          expect(kind(names.other)).toBe("opencode");
        }
      } finally {
        closeAll([host, obs]);
      }
    });
  }

  it("sends a pre-token daemon only the original three kinds", async () => {
    const host = await at(
      (await machine(uniq("Zeta"))).token,
      KIND_TOKEN_MIN_CLIENT,
    );
    const old = await at((await machine(uniq("Old"))).token, "0.44.1");
    try {
      const n = ns("zeta");
      const zeta = uniq("zeta");
      const pi = uniq("pi");
      await agent(host, "r-zeta", zeta, n);
      await agent(host, "r-pi", pi, n);
      await agent(old, "r-old", uniq("old"), n);
      // A kind no agent_up can register yet: written straight to storage.
      await inOwnerHub((s) =>
        s.storage.sql.exec(
          "update agents set kind = 'zeta' where name = ?",
          zeta,
        ),
      );
      const seen = (await list(old, "r-old")).agents.map((a) => a.bus_name);
      expect(seen).toContain(pi);
      expect(seen).not.toContain(zeta);
      expect(old.raw.some((t) => t.includes('"zeta"'))).toBe(false);
      const r = (await list(host, "r-pi")).agents;
      expect(r.find((a) => a.bus_name === zeta)?.kind).toBe("zeta");
    } finally {
      closeAll([host, old]);
    }
  });

  it("roster_changed never carries a kind, so it needs no gate", async () => {
    const obs = await at((await machine(uniq("Old"))).token, "0.44.1");
    const host = await at(
      (await machine(uniq("New"))).token,
      KIND_TOKEN_MIN_CLIENT,
    );
    try {
      const n = ns("omp");
      await agent(obs, "r-old", uniq("old"), n);
      await agent(host, "r-new", uniq("omp"), n, { kind: "omp" });
      const f = await waitFor(obs, "roster_changed");
      expect(Object.keys(f).sort()).toEqual(["id", "namespace", "type", "v"]);
      neverSawOmp(obs);
    } finally {
      closeAll([host, obs]);
    }
  });

  it("keeps the version in the socket attachment (survives hibernation)", async () => {
    const m = await machine(uniq("Hibernate"));
    const { host, obs, names, n } = await scene(null);
    // A dedicated socket whose attachment we inspect and rewrite.
    const d = await at(m.token, KIND_TOKEN_MIN_CLIENT);
    try {
      await agent(d, "r-h", uniq("h"), n);
      const attachment = () =>
        inOwnerHub((s) =>
          s
            .getWebSockets(m.id)
            .map((w) => w.deserializeAttachment() as Record<string, unknown>),
        );
      expect(await attachment()).toEqual([
        { machineId: m.id, clientVersion: KIND_TOKEN_MIN_CLIENT },
      ]);
      expect((await list(d, "r-h")).agents.map((a) => a.bus_name)).toContain(
        names.omp,
      );

      // The gate reads the attachment, not memory: what a woken hub has.
      await inOwnerHub((s) => {
        for (const w of s.getWebSockets(m.id))
          w.serializeAttachment({ machineId: m.id, clientVersion: "0.44.1" });
      });
      expect(
        (await list(d, "r-h")).agents.map((a) => a.bus_name),
      ).not.toContain(names.omp);
    } finally {
      closeAll([host, obs, d]);
    }
  });
});
