import { HttpResponse, http } from "msw";
import type { Agent, BusEvent, Machine } from "../api/contract";
import { fixtures } from "./fixtures";

type Err = "csrf" | "not_found";
const fail = (status: number, code: Err, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status });

/**
 * Mutable mock state plus the frame bus the SSE handler and the e2e hook share.
 * Revoke mirrors the hub: the machine keeps its row (revokedAt set), its agents go.
 */
export function createMockBus() {
  let machines: Machine[] = structuredClone(fixtures.machines);
  let agents: Agent[] = structuredClone(fixtures.agents);
  const subscribers = new Set<(e: BusEvent) => void>();

  const push = (e: BusEvent) => {
    for (const fn of subscribers) fn(e);
  };

  return {
    machines: () => machines,
    agents: () => agents,
    push,
    subscribe(fn: (e: BusEvent) => void) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    /** DELETE /api/v1/machines/:id: 204, or 404 when unknown or already revoked. */
    async revoke(id: string) {
      const m = machines.find((x) => x.id === id);
      if (!m || m.revokedAt) {
        return fail(404, "not_found", "No such machine");
      }
      machines = machines.map((x) =>
        x.id === id ? { ...x, revokedAt: new Date().toISOString() } : x,
      );
      agents = agents.filter((a) => a.machineId !== id);
      push({ type: "agents", agents });
      push({ type: "machines", machines });
      return new HttpResponse(null, { status: 204 });
    },
    /** Test/dev hook: pretend the hub announced a new roster. */
    setAgents(next: Agent[]) {
      agents = next;
      push({ type: "agents", agents });
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
      const all = bus.agents();
      return HttpResponse.json({
        agents: ns ? all.filter((a) => a.namespace === ns) : all,
      });
    }),
    http.delete("*/api/v1/machines/:id", ({ request, params }) => {
      if (request.headers.get("X-OB-Request") !== "1") {
        return fail(403, "csrf", "Missing X-OB-Request header");
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
          send({ type: "hello" });
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
