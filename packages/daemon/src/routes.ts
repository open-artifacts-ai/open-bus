import type { AdapterFrame, DaemonFrame, Hello, Unframed } from "@ob/ipc";
import {
  type ClientFrame,
  ClientFrameSchema,
  frameId,
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
  reply: (f: DaemonFrame) => void;
  timer: NodeJS.Timeout;
};

/**
 * Local requests waiting on the hub. Each gets a fresh hub id, so two adapters
 * reusing a local id never receive each other's answers.
 */
export class Pending {
  #byHubId = new Map<string, Waiter>();
  constructor(private readonly timeoutMs = 10_000) {}

  open(localId: string, reply: (f: DaemonFrame) => void): string {
    const hubId = frameId();
    const timer = setTimeout(
      () => this.#fail(hubId, "timeout", "the hub did not answer"),
      this.timeoutMs,
    );
    timer.unref();
    this.#byHubId.set(hubId, { localId, reply, timer });
    return hubId;
  }

  settle(frame: HubReply): boolean {
    const w = this.#take(frame.id);
    if (!w) return false;
    if (frame.type === "error") {
      w.reply({
        v: 1,
        id: w.localId,
        type: "error",
        code: frame.code,
        message: frame.message,
      });
      return true;
    }
    // The hub's roster lists live agents under `bus_name`; adapters see `name` and `live`.
    w.reply(
      frame.type === "roster"
        ? {
            ...frame,
            id: w.localId,
            agents: frame.agents.map(({ bus_name, ...a }) => ({
              ...a,
              name: bus_name,
              live: true,
            })),
          }
        : { ...frame, id: w.localId },
    );
    return true;
  }

  cancel(hubId: string): void {
    this.#take(hubId);
  }

  failAll(code: string, message: string): void {
    for (const hubId of [...this.#byHubId.keys()])
      this.#fail(hubId, code, message);
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

export type RouteCtx = {
  agents: AgentTable;
  hub: Pick<HubConnection, "send">;
  pending: Pending;
  /** Acks msg_id if it is being delivered to ref right now; false otherwise. */
  confirm: (msgId: string, ref: string) => boolean;
};

/** A local request is attributed to the connection's attested agent, never to a frame field. */
export function routeLocal(
  frame: Exclude<AdapterFrame, { type: "hello" }>,
  hello: Hello,
  reply: (f: DaemonFrame) => void,
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
