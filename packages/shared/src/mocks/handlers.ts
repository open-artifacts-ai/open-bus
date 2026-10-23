import { HttpResponse, http } from "msw";
import { type ApiError, type ErrorCode, STATUS_FOR } from "../errors.js";
import { LIMITS } from "../limits.js";
import {
  type Agent,
  type BusEvent,
  CSRF_HEADER,
  CSRF_VALUE,
  type Machine,
  R,
} from "../rest.js";
import {
  agents as agentFixtures,
  machines as machineFixtures,
  me,
} from "./fixtures.js";

let machineRows: Machine[] = structuredClone(machineFixtures);
let agentRows: Agent[] = structuredClone(agentFixtures);

/** Restore fixtures; call in `afterEach` so mutations never leak between tests. */
export function resetMocks(): void {
  machineRows = structuredClone(machineFixtures);
  agentRows = structuredClone(agentFixtures);
}

const fail = (code: ErrorCode, message: string) =>
  HttpResponse.json({ error: { code, message } } satisfies ApiError, {
    status: STATUS_FOR[code],
  });

const listMachines = (): Machine[] =>
  [...machineRows]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, LIMITS.maxMachinesListed);

const frame = (e: BusEvent): Uint8Array =>
  new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`);

export const handlers = [
  http.get(`*${R.me}`, () => HttpResponse.json(me)),
  http.get(`*${R.machines}`, () =>
    HttpResponse.json({ machines: listMachines() }),
  ),
  http.delete("*/api/v1/machines/:id", ({ request, params }) => {
    if (request.headers.get(CSRF_HEADER) !== CSRF_VALUE)
      return fail("csrf", `Missing ${CSRF_HEADER} header`);
    const m = machineRows.find((x) => x.id === params.id);
    if (!m || m.revokedAt) return fail("not_found", "No such machine");
    m.revokedAt = new Date().toISOString();
    // Revoke closes the socket, so the machine's agents leave the roster.
    agentRows = agentRows.filter((a) => a.machineId !== m.id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`*${R.agents}`, ({ request }) => {
    const ns = new URL(request.url).searchParams.get("namespace");
    return HttpResponse.json({
      agents: agentRows
        .filter((a) => !ns || a.namespace === ns || a.global)
        .slice(0, LIMITS.maxRosterAgents),
    });
  }),
  // Sends hello, machines, agents once; later changes are not pushed (the dashboard
  // keeps its own createMockBus for live pushes).
  http.get(`*${R.events}`, () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(frame({ type: "hello" }));
        c.enqueue(frame({ type: "machines", machines: listMachines() }));
        c.enqueue(frame({ type: "agents", agents: agentRows }));
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
