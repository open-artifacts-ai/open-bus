// C23a: a published 0.44.x daemon's roster decoder, frozen. Its `kind` is the
// strict three-kind enum of v0.44.1 (packages/shared/src/kinds.ts at the tag;
// protocol.ts's RosterAgent and Roster are unchanged since). The hub's gate
// must hand it a roster it decodes even with an omp agent registered.
import {
  BusNameSchema,
  LIMITS,
  MachineLabelSchema,
  OMP_MIN_CLIENT,
  PONG,
  WireNamespaceSchema,
} from "@ob/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Daemon, daemon, machine, ns, up, waitFor } from "./helpers.js";

const V0441_KINDS = ["claude-code", "opencode", "pi"] as const;
const V0441Roster = z.strictObject({
  v: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  type: z.literal("roster"),
  agents: z
    .array(
      z.strictObject({
        bus_name: BusNameSchema,
        kind: z.enum(V0441_KINDS),
        namespace: WireNamespaceSchema,
        global: z.boolean(),
        state: z.enum(["live", "queued"]),
        machine_label: MachineLabelSchema.optional(),
      }),
    )
    .max(LIMITS.maxRosterAgents),
});

let seq = 0;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;

async function at(token: string, version: string): Promise<Daemon> {
  const d = await daemon(token);
  d.send({
    v: 1,
    id: `h${++seq}`,
    type: "hello",
    machine_label: "MacBook",
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
  kind: "omp" | "pi",
  global = false,
): Promise<void> {
  const f = up(`u-${ref}-${++seq}`, ref, name, namespace, global);
  if (f.type !== "agent_up") throw new Error("up builds an agent_up");
  d.send({ ...f, kind });
  expect((await waitFor(d, "agent_ok")).bus_name).toBe(name);
}

/** The raw text of the roster reply to a fresh `list`. */
async function rawList(d: Daemon, from_ref: string): Promise<string> {
  const id = `l${++seq}`;
  d.send({ v: 1, id, type: "list", from_ref });
  for (;;) {
    const r = await waitFor(d, "roster");
    if (r.id !== id) continue;
    const raw = d.raw.find(
      (t) => t !== PONG && t.includes('"roster"') && t.includes(`"${id}"`),
    );
    if (raw === undefined) throw new Error("no raw roster");
    return raw;
  }
}

describe("a 0.44.1 daemon's roster decoder", () => {
  it("decodes the hub's roster with an omp agent registered", async () => {
    const host = await at((await machine(uniq("Omp"))).token, OMP_MIN_CLIENT);
    const old = await at((await machine(uniq("Old"))).token, "0.44.1");
    try {
      const n = ns("compat");
      const pi = uniq("pi");
      await register(host, "r-omp", uniq("omp"), n, "omp");
      await register(host, "r-ompg", uniq("ompg"), n, "omp", true);
      await register(host, "r-pi", pi, n, "pi");
      await register(old, "r-old", uniq("old"), n, "pi");
      await register(old, "r-oldg", uniq("oldg"), n, "pi", true);
      for (const from of ["r-old", "r-oldg"]) {
        const r = V0441Roster.safeParse(JSON.parse(await rawList(old, from)));
        expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
        expect(r.data?.agents.map((a) => a.bus_name)).toContain(pi);
      }
    } finally {
      for (const d of [host, old])
        try {
          d.close();
        } catch {
          // Already closed.
        }
    }
  });

  it("refuses the same roster ungated (the control)", async () => {
    const host = await at((await machine(uniq("Omp"))).token, OMP_MIN_CLIENT);
    try {
      const n = ns("compat");
      await register(host, "r-omp", uniq("omp"), n, "omp");
      const r = V0441Roster.safeParse(JSON.parse(await rawList(host, "r-omp")));
      expect(r.success).toBe(false);
    } finally {
      host.close();
    }
  });
});
