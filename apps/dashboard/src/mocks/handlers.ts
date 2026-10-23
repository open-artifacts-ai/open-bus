import { HttpResponse, http } from "msw";
import {
  type Agent,
  AgentsResponseSchema,
  type BusEvent,
  BusEventSchema,
  CSRF_HEADER,
  CSRF_VALUE,
  type Machine,
  MachinesResponseSchema,
  WireNamespaceSchema,
} from "../api/contract";
import { fixtures } from "./fixtures";

type Err = "bad_request" | "csrf" | "not_found";
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
 * Mutable mock state plus the frame bus the SSE handler and the e2e hook share.
 * Revoke mirrors the hub: the machine keeps its row (revokedAt set), its agents go.
 */
export function createMockBus() {
  let machineRows: Machine[] = structuredClone(fixtures.machines);
  let agentRows: Agent[] = structuredClone(fixtures.agents);
  const subscribers = new Set<(e: BusEvent) => void>();

  // Like the hub: active machines first, then revoked, each newest first; every agent that can receive mail is
  // listed, live and queued (closed agents never reach the roster).
  const machines = () =>
    [...machineRows].sort(
      (a, b) =>
        Number(a.revokedAt !== null) - Number(b.revokedAt !== null) ||
        b.createdAt.localeCompare(a.createdAt),
    );
  const agents = () => [...agentRows];

  /** Every frame goes through the schema, so a bad e2e push throws here. */
  const push = (e: BusEvent) => {
    const frame = BusEventSchema.parse(e);
    for (const fn of subscribers) fn(frame);
  };

  return {
    machines,
    agents,
    push,
    /** The frames a new stream opens with: hello, then both full snapshots. */
    greeting(): BusEvent[] {
      return [
        { type: "hello" },
        { type: "machines", machines: machines() },
        { type: "agents", agents: agents() },
      ];
    },
    subscribe(fn: (e: BusEvent) => void) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
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

/** HTTP handlers: me, machines, agents, revoke, and the SSE stream. */
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
      request.headers.get("X-OB-Request") === "1"
        ? new HttpResponse(null, { status: 204 })
        : fail(403, "csrf", "Missing X-OB-Request header"),
    ),
    http.delete("*/api/v1/machines/:id", ({ request, params }) => {
      if (request.headers.get(CSRF_HEADER) !== CSRF_VALUE) {
        return fail(403, "csrf", `Missing ${CSRF_HEADER} header`);
      }
      return bus.revoke(String(params.id));
    }),
    http.get("*/api/v1/events", () => {
      const enc = new TextEncoder();
      let off: (() => void) | null = null;
      const stream = new ReadableStream({
        start(controller) {
          const send = (e: BusEvent) => {
            try {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            } catch {
              /* the client went away */
            }
          };
          off = bus.subscribe(send);
          for (const e of bus.greeting()) send(e);
        },
        cancel() {
          off?.();
        },
      });
      return new HttpResponse(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        },
      });
    }),
  ];
}
