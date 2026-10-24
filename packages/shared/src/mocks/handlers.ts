import { HttpResponse, http, type WebSocketLink, ws } from "msw";
import { type ApiError, type ErrorCode, STATUS_FOR } from "../errors.js";
import { LIMITS } from "../limits.js";
import { PING, PONG } from "../protocol.js";
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
    .sort(
      (a, b) =>
        Number(a.revokedAt !== null) - Number(b.revokedAt !== null) ||
        b.createdAt.localeCompare(a.createdAt),
    )
    .slice(0, LIMITS.maxMachinesListed);

/**
 * The dashboard feed's msw WebSocket link, on any origin. Frontend can pass
 * its own link to `eventsHandler`, `broadcast` and `closeAll` instead.
 */
export const eventsLink: WebSocketLink = ws.link(`*${R.events}`);

/** Where the greeting reads its lists: called on every connection, never cached. */
export type WsStateProviders = {
  machines: () => Machine[];
  agents: () => Agent[];
};

/** The shared mock state the REST handlers serve, so REST and WS always agree. */
export const mockStateProviders: WsStateProviders = {
  machines: () => listMachines(),
  agents: () => agentRows.slice(0, LIMITS.maxRosterAgents),
};

/**
 * The feed handler on `link`. On each connection it sends hello, then
 * machines, then agents, read from `providers` at that moment (one JSON text
 * frame each), answers "ping" with "pong" and ignores every other client
 * frame, as the hub does.
 */
export function createWsHandler(
  providers: WsStateProviders = mockStateProviders,
  link: WebSocketLink = eventsLink,
) {
  return link.addEventListener("connection", ({ client }) => {
    const send = (e: BusEvent) => client.send(JSON.stringify(e));
    send({ type: "hello" });
    send({ type: "machines", machines: providers.machines() });
    send({ type: "agents", agents: providers.agents() });
    client.addEventListener("message", (ev) => {
      if (ev.data === PING) client.send(PONG);
    });
  });
}

/** `createWsHandler` over the shared mock state, on `link`. */
export const eventsHandler = (link: WebSocketLink = eventsLink) =>
  createWsHandler(mockStateProviders, link);

/** The handler on `eventsLink`, included in `handlers`. */
export const eventsWsHandler = eventsHandler();

/** Sends `event` as one frame to every client connected to `link`. */
export function broadcast(
  event: BusEvent,
  link: WebSocketLink = eventsLink,
): void {
  link.broadcast(JSON.stringify(event));
}

/**
 * Closes every client on `link` with `code` (for example
 * `LIMITS.dashboardSessionClose`, 4401, or `LIMITS.revokeCloseCode`).
 */
export function closeAll(
  code: number,
  link: WebSocketLink = eventsLink,
  reason = "closed",
): void {
  for (const c of [...link.clients]) c.close(code, reason);
}

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
    m.connected = false;
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
  eventsWsHandler,
];
