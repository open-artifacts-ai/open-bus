import type { AdapterFrame, DaemonFrame, Hello, Unframed } from "@ob/ipc";
import {
  AGENT_CAP_MESSAGES,
  type ClientFrame,
  ClientFrameSchema,
  frameId,
  rosterState,
  type ServerFrame,
} from "@ob/shared";
import type { AgentTable } from "./agents.ts";
import type { HubConnection } from "./hub.ts";

export type HubReply = Extract<
  ServerFrame,
  { type: "receipt" | "roster" | "body" | "error" }
>;

type Waiter = {
  localId: string;
  /** False when the request's connection is gone: nothing was written. */
  reply: (f: DaemonFrame) => unknown;
  timer: NodeJS.Timeout;
};

/**
 * Local requests waiting on the hub. Each gets a fresh hub id, so two adapters
 * reusing a local id never receive each other's answers.
 */
export class Pending {
  #byHubId = new Map<string, Waiter>();
  constructor(
    private readonly timeoutMs = 10_000,
    /** A request given up on: its frame, if still queued, must not go out late. */
    private readonly onTimeout?: (hubId: string) => void,
  ) {}

  open(localId: string, reply: (f: DaemonFrame) => unknown): string {
    const hubId = frameId();
    const timer = setTimeout(() => {
      this.onTimeout?.(hubId);
      this.#fail(hubId, "timeout", "the hub did not answer");
    }, this.timeoutMs);
    timer.unref();
    this.#byHubId.set(hubId, { localId, reply, timer });
    return hubId;
  }

  settle(frame: HubReply): boolean {
    const w = this.#take(frame.id);
    if (!w) return false;
    this.#answer(w, frame);
    return true;
  }

  /** Takes the request off the clock: the caller answers it later, once; false if nothing was written. */
  hold(hubId: string): ((frame: HubReply) => boolean) | undefined {
    const w = this.#take(hubId);
    return w && ((frame) => this.#answer(w, frame));
  }

  #answer(w: Waiter, frame: HubReply): boolean {
    if (frame.type === "error") {
      const ok = w.reply({
        v: 1,
        id: w.localId,
        type: "error",
        code: frame.code,
        message: frame.message,
      });
      return ok !== false;
    }
    // The hub's roster names agents `bus_name`; adapters see `name`, `state` and `live`.
    const ok = w.reply(
      frame.type === "roster"
        ? {
            ...frame,
            id: w.localId,
            agents: frame.agents.map(({ bus_name, ...a }) => {
              const state = rosterState(a);
              return { ...a, name: bus_name, state, live: state === "live" };
            }),
          }
        : { ...frame, id: w.localId },
    );
    return ok !== false;
  }

  cancel(hubId: string): void {
    this.#take(hubId);
  }

  /** Answers one waiting request with an error; false when none waits under that id. */
  fail(hubId: string, code: string, message: string): boolean {
    if (!this.#byHubId.has(hubId)) return false;
    this.#fail(hubId, code, message);
    return true;
  }

  /** `keep`: requests that still wait (a send that will be resent). */
  failAll(
    code: string,
    message: string,
    keep: (hubId: string) => boolean = () => false,
  ): void {
    for (const hubId of [...this.#byHubId.keys()])
      if (!keep(hubId)) this.#fail(hubId, code, message);
  }

  #fail(hubId: string, code: string, message: string): void {
    const w = this.#take(hubId);
    w?.reply({ v: 1, id: w.localId, type: "error", code, message });
  }

  #take(hubId: string): Waiter | undefined {
    const w = this.#byHubId.get(hubId);
    if (!w) return undefined;
    this.#byHubId.delete(hubId);
    clearTimeout(w.timer);
    return w;
  }
}

/** Draft copy (Design to confirm): what an agent the hub refused to register sees, per cap. */
export const MACHINE_CAP_COPY =
  "This machine has too many agents on the bus right now. Close a session you no longer need; this one retries in a few minutes.";
export const ORG_CAP_COPY =
  "Your bus has too many agents right now. Close a session you no longer need; this one retries in a few minutes.";

export type AgentCap = "machine" | "org";
export const CAP_COPY: Record<AgentCap, string> = {
  machine: MACHINE_CAP_COPY,
  org: ORG_CAP_COPY,
};

/** Which cap a `rate_limited` agent_up message names; an unknown message counts as the machine's. */
export function capOf(message: string): AgentCap {
  return message === AGENT_CAP_MESSAGES.org ? "org" : "machine";
}

export type RouteCtx = {
  agents: AgentTable;
  hub: Pick<HubConnection, "send">;
  pending: Pending;
  /** Acks msg_id if it is being delivered to ref right now; false otherwise. */
  confirm: (msgId: string, ref: string) => boolean;
  /** The cap while the hub refuses to register ref (`rate_limited` agent_up). */
  limited?: (ref: string) => AgentCap | undefined;
};

/** A local request is attributed to the connection's attested agent, never to a frame field. */
export function routeLocal(
  frame: Exclude<AdapterFrame, { type: "hello" }>,
  hello: Hello,
  reply: (f: DaemonFrame) => unknown,
  ctx: RouteCtx,
): Unframed | undefined {
  const agent = ctx.agents.byRef(hello.agent_ref);
  if (!agent)
    return { type: "error", code: "unauthorized", message: "unknown agent" };
  const ref = agent.ref;

  switch (frame.type) {
    case "self":
      return {
        type: "agent",
        agent: {
          name: agent.busName,
          namespace: agent.namespace,
          kind: agent.kind,
          live: agent.live,
          global: agent.global,
        },
      };
    case "ack":
      // The hub's ack carries no sender, so only the delivery's own agent may send one.
      if (ctx.confirm(frame.msg_id, ref)) return undefined;
      return {
        type: "error",
        code: "unauthorized",
        message: "not a delivery to this agent",
      };
    case "list":
    case "send":
    case "fetch": {
      // The hub would answer not_registered; say why instead.
      const cap = ctx.limited?.(ref);
      if (cap)
        return {
          type: "error",
          code: "rate_limited",
          message: CAP_COPY[cap],
        };
      const build = (id: string): ClientFrame =>
        frame.type === "list"
          ? { v: 1, id, type: "list", from_ref: ref }
          : frame.type === "send"
            ? {
                v: 1,
                id,
                type: "send",
                from_ref: ref,
                to_name: frame.to,
                ...(frame.namespace ? { to_namespace: frame.namespace } : {}),
                body: frame.body,
              }
            : { v: 1, id, type: "fetch", from_ref: ref, msg_id: frame.msg_id };
      // Never forward what the hub's decoder would reject.
      if (!ClientFrameSchema.safeParse(build("probe")).success)
        return {
          type: "error",
          code: "bad_frame",
          message: "the frame is not valid on the hub wire",
        };
      const id = ctx.pending.open(frame.id, reply);
      if (ctx.hub.send(build(id))) return undefined;
      ctx.pending.cancel(id);
      return {
        type: "error",
        code: "hub_unavailable",
        message: "the hub is not connected",
      };
    }
  }
}
