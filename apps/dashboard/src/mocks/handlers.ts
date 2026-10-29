import { broadcast, closeAll, createWsHandler } from "@ob/shared/mocks";
import { HttpResponse, http, ws } from "msw";
import {
  type Agent,
  AgentsResponseSchema,
  type BusEvent,
  BusEventSchema,
  BusNameSchema,
  CSRF_HEADER,
  CSRF_VALUE,
  LIMITS,
  type LinkedApp,
  type Machine,
  MachinesResponseSchema,
  PutRoleBodySchema,
  R,
  type Role,
  WireNamespaceSchema,
} from "../api/contract";
import { fixtures } from "./fixtures";

/** Our own link (not the shared one), so push/closeAll reach only our clients. */
const link = ws.link(`*${R.events}`);

type Err = "bad_request" | "conflict" | "csrf" | "not_found";
const fail = (
  status: number,
  code: Err,
  message: string,
  details?: { field: string },
) =>
  HttpResponse.json(
    { error: details ? { code, message, details } : { code, message } },
    { status },
  );

/**
 * Mutable mock state plus the frame bus the WebSocket link and the e2e hook share.
 * Revoke mirrors the hub: the machine keeps its row (revokedAt set), its agents go.
 */
export function createMockBus() {
  let machineRows: Machine[] = structuredClone(fixtures.machines);
  const T = new Date().toISOString();
  // Fixtures carry no self-reported status; the mock adds some.
  let agentRows: Agent[] = structuredClone(fixtures.agents).map((a, i) =>
    i === 0
      ? { ...a, status: "working", statusLabel: "writing tests", statusAt: T }
      : i === 1
        ? { ...a, status: "idle", statusAt: T }
        : a,
  );
  const holder = fixtures.agents[0];
  let roleRows: Role[] = [
    {
      namespace: holder?.namespace ?? "github.com/acme/app",
      role: "lane-6",
      agentId: holder?.id ?? null,
      setAt: T,
    },
    {
      namespace: "github.com/acme/app",
      role: "reviewer",
      agentId: null,
      setAt: T,
    },
  ];
  let appRows: LinkedApp[] = [{ aud: "https://oa.example", linkedAt: T }];
  const withRoles = (): Agent[] =>
    agentRows.map((a) => {
      const r = roleRows.find((x) => x.agentId === a.id);
      // A role injected through setAgents stays when no role row claims the agent.
      return r ? { ...a, role: r.role } : a;
    });
  const subscribers = new Set<(e: BusEvent) => void>();

  // Like the hub: active machines first, then revoked, each newest first.
  // Every agent that can receive mail is listed, live and queued (closed
  // agents never reach the roster).
  const machines = () =>
    [...machineRows].sort(
      (a, b) =>
        Number(a.revokedAt !== null) - Number(b.revokedAt !== null) ||
        b.createdAt.localeCompare(a.createdAt),
    );
  const agents = () => withRoles();
  const roles = () => [...roleRows];
  const apps = () => [...appRows];

  /** Every frame goes through the schema, so a bad e2e push throws here. */
  const push = (e: BusEvent) => {
    const frame = BusEventSchema.parse(e);
    for (const fn of subscribers) fn(frame);
    broadcast(frame, link);
  };

  function subscribe(fn: (e: BusEvent) => void) {
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }

  // The shared handler owns the greeting and ping/pong; it reads our live state
  // on every connect. Our own link keeps broadcast/closeAll off the shared one.
  const events = createWsHandler({ machines, agents }, link);

  return {
    machines,
    agents,
    push,
    subscribe,
    /** The msw handler for the events WebSocket (see handlersFor). */
    events,
    /**
     * Test/dev hook: the hub closes every open stream with `code` (4401 the
     * session ended, 1013 evicted, 1011 a send failed).
     */
    closeAll(code: number) {
      closeAll(code, link, "mock");
    },
    /** DELETE /api/v1/machines/:id: 204, or 404 when unknown or already revoked. */
    async revoke(id: string) {
      const m = machineRows.find((x) => x.id === id);
      if (!m || m.revokedAt) {
        return fail(404, "not_found", "No such machine");
      }
      machineRows = machineRows.map((x) =>
        x.id === id
          ? { ...x, revokedAt: new Date().toISOString(), connected: false }
          : x,
      );
      agentRows = agentRows.filter((a) => a.machineId !== id);
      push({ type: "agents", agents: agents() });
      push({ type: "machines", machines: machines() });
      return new HttpResponse(null, { status: 204 });
    },
    roles,
    apps,
    /**
     * PUT /api/v1/roles/:ns/:role. 400 when the holder is not an open agent in
     * scope; 409 when the role is an open agent's name or the agent already
     * holds another role, or the bus already has `LIMITS.maxRoles` roles.
     */
    async setRole(namespace: string, role: string, body: unknown) {
      if (!WireNamespaceSchema.safeParse(namespace).success)
        return fail(400, "bad_request", "Invalid namespace", {
          field: "namespace",
        });
      if (!BusNameSchema.safeParse(role).success)
        return fail(400, "bad_request", "Invalid role name", { field: "role" });
      const parsed = PutRoleBodySchema.safeParse(body);
      const holder = parsed.success
        ? agentRows.find((a) => a.id === parsed.data.agentId)
        : undefined;
      if (!holder || !(holder.namespace === namespace || holder.global))
        return fail(
          400,
          "bad_request",
          "That agent is not open in this namespace",
          {
            field: "agentId",
          },
        );
      // The server's exact 409s (apps/server/src/routes/roles.ts).
      if (agentRows.some((a) => a.name === role && a.namespace === namespace))
        return fail(409, "conflict", "An agent already has that name");
      if (roleRows.some((r) => r.agentId === holder.id && r.role !== role))
        return fail(409, "conflict", "That agent already has a role");
      if (
        roleRows.length >= LIMITS.maxRoles &&
        !roleRows.some((r) => r.namespace === namespace && r.role === role)
      )
        return fail(409, "conflict", "Too many roles");
      const row: Role = {
        namespace,
        role,
        agentId: holder.id,
        setAt: new Date().toISOString(),
      };
      roleRows = [
        ...roleRows.filter(
          (r) => !(r.namespace === namespace && r.role === role),
        ),
        row,
      ];
      push({ type: "agents", agents: agents() });
      return new HttpResponse(null, { status: 204 });
    },
    /** DELETE /api/v1/roles/:ns/:role: 204, or 404 when already gone. */
    async removeRole(namespace: string, role: string) {
      if (!roleRows.some((r) => r.namespace === namespace && r.role === role))
        return fail(404, "not_found", "No such role");
      roleRows = roleRows.filter(
        (r) => !(r.namespace === namespace && r.role === role),
      );
      push({ type: "agents", agents: agents() });
      return new HttpResponse(null, { status: 204 });
    },
    /** DELETE /api/v1/linked-apps/:aud: 204, or 404 when already gone. */
    async unlink(aud: string) {
      if (!appRows.some((a) => a.aud === aud))
        return fail(404, "not_found", "No such linked app");
      appRows = appRows.filter((a) => a.aud !== aud);
      return new HttpResponse(null, { status: 204 });
    },
    /**
     * Test/dev hook: pretend the hub announced a new roster. Validates the
     * whole input (schema and list cap) before touching state; throws on bad input.
     */
    setAgents(next: unknown) {
      agentRows = AgentsResponseSchema.parse({ agents: next }).agents;
      push({ type: "agents", agents: agents() });
    },
    /** Test/dev hook: pretend the hub announced new machines. Same rules as setAgents. */
    setMachines(next: unknown) {
      machineRows = MachinesResponseSchema.parse({ machines: next }).machines;
      push({ type: "machines", machines: machines() });
    },
  };
}

export type MockBus = ReturnType<typeof createMockBus>;

/** Handlers: me, machines, agents, revoke, roles, linked apps, and the events WebSocket. */
export function handlersFor(bus: MockBus) {
  return [
    http.get("*/api/v1/me", () => HttpResponse.json(fixtures.me)),
    http.get("*/api/v1/machines", () =>
      HttpResponse.json({ machines: bus.machines() }),
    ),
    http.get("*/api/v1/agents", ({ request }) => {
      const ns = new URL(request.url).searchParams.get("namespace");
      // Like the hub: ?namespace= is exact and must already be canonical.
      if (ns !== null && !WireNamespaceSchema.safeParse(ns).success) {
        return fail(400, "bad_request", "Invalid namespace", {
          field: "namespace",
        });
      }
      const all = bus.agents();
      return HttpResponse.json({
        agents: ns ? all.filter((a) => a.namespace === ns || a.global) : all,
      });
    }),
    http.post("*/auth/logout", ({ request }) =>
      request.headers.get(CSRF_HEADER) === CSRF_VALUE
        ? new HttpResponse(null, { status: 204 })
        : fail(403, "csrf", `Missing ${CSRF_HEADER} header`),
    ),
    http.delete("*/api/v1/machines/:id", ({ request, params }) => {
      if (request.headers.get(CSRF_HEADER) !== CSRF_VALUE) {
        return fail(403, "csrf", `Missing ${CSRF_HEADER} header`);
      }
      return bus.revoke(String(params.id));
    }),
    http.get("*/api/v1/roles", () => HttpResponse.json({ roles: bus.roles() })),
    http.put("*/api/v1/roles/:ns/:role", async ({ request, params }) => {
      if (request.headers.get(CSRF_HEADER) !== CSRF_VALUE) {
        return fail(403, "csrf", `Missing ${CSRF_HEADER} header`);
      }
      const body = await request.json().catch(() => undefined);
      return bus.setRole(
        decodeURIComponent(String(params.ns)),
        decodeURIComponent(String(params.role)),
        body,
      );
    }),
    http.delete("*/api/v1/roles/:ns/:role", ({ request, params }) => {
      if (request.headers.get(CSRF_HEADER) !== CSRF_VALUE) {
        return fail(403, "csrf", `Missing ${CSRF_HEADER} header`);
      }
      return bus.removeRole(
        decodeURIComponent(String(params.ns)),
        decodeURIComponent(String(params.role)),
      );
    }),
    http.get("*/api/v1/linked-apps", () =>
      HttpResponse.json({ apps: bus.apps() }),
    ),
    http.delete("*/api/v1/linked-apps/:aud", ({ request, params }) => {
      if (request.headers.get(CSRF_HEADER) !== CSRF_VALUE) {
        return fail(403, "csrf", `Missing ${CSRF_HEADER} header`);
      }
      return bus.unlink(decodeURIComponent(String(params.aud)));
    }),
    bus.events,
  ];
}
