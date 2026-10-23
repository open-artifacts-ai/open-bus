import { randomUUID } from "node:crypto";
import type { AgentRecord, AgentTable } from "./agents.ts";
import { Seen } from "./dedupe.ts";
import type { HubConnection } from "./hub.ts";
import type { DaemonToHub, HubToDaemon } from "./wire.ts";

export type Mail = {
  msg_id: string;
  from_name: string;
  namespace: string;
  body: string;
};
type Detail = Extract<DaemonToHub, { type: "refuse" }>["detail"];
/** `cause` means the harness turned it down; `closed` alone means the session is gone. */
export type DeliverOutcome =
  | { ok: true }
  | { ok: false; reason: "closed" | "timeout"; cause?: Detail };
export type DeliverFn = (
  agent: AgentRecord,
  mail: Mail,
) => Promise<DeliverOutcome>;
export type DeliverFrame = Extract<HubToDaemon, { type: "deliver" }>;

export function createDeliver(ctx: {
  agents: AgentTable;
  hub: Pick<HubConnection, "send">;
  transports: Partial<Record<AgentRecord["kind"], DeliverFn>>;
  /** The transport found the session closed; report it to the hub. */
  onClosed: (agent: AgentRecord) => void;
  log?: (msg: string) => void;
}) {
  // Seen means delivered: an id is added only after the harness confirms it.
  const seen = new Seen();
  const inflight = new Map<
    string,
    { ref: string; done: Promise<DeliverOutcome> }
  >();
  const ack = (msg_id: string) =>
    ctx.hub.send({ v: 1, id: randomUUID(), type: "ack", msg_id });
  const refuse = (msg_id: string, detail: Detail) =>
    ctx.hub.send({
      v: 1,
      id: randomUUID(),
      type: "refuse",
      msg_id,
      reason: "closed",
      detail,
    });

  const deliver = async (frame: DeliverFrame): Promise<void> => {
    const { msg_id } = frame;
    if (seen.has(msg_id)) {
      ack(msg_id); // the hub redelivers after a missed ack
      return;
    }
    const running = inflight.get(msg_id);
    if (running) {
      // A redelivery while the first attempt is in flight joins it.
      if ((await running.done).ok) ack(msg_id);
      return;
    }
    const agent = ctx.agents.byRef(frame.to_ref);
    const fn = agent?.live ? ctx.transports[agent.kind] : undefined;
    if (!agent || !fn) {
      refuse(msg_id, "dropped"); // waking a closed session injects nothing
      return;
    }
    const body =
      frame.body ??
      `[openbus] A message of ${frame.notice?.size ?? 0} bytes is too large to deliver inline. Fetch it with the openbus fetch tool, msg_id ${msg_id}.`;
    const done = fn(agent, {
      msg_id,
      from_name: frame.from_name,
      namespace: frame.namespace,
      body,
    }).catch((e: unknown): DeliverOutcome => {
      ctx.log?.(
        `transport threw: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { ok: false, reason: "timeout" };
    });
    inflight.set(msg_id, { ref: agent.ref, done });
    const outcome = await done.finally(() => inflight.delete(msg_id));
    if (outcome.ok) {
      seen.add(msg_id);
      ack(msg_id);
    } else if (outcome.cause) {
      refuse(msg_id, outcome.cause);
    } else if (outcome.reason === "closed") {
      agent.live = false;
      ctx.onClosed(agent);
      refuse(msg_id, "dropped");
    }
    // A timeout stays unrecorded and unacked, so the hub's retry is attempted again.
  };

  return {
    deliver,
    owns: (msgId: string, ref: string) => inflight.get(msgId)?.ref === ref,
  };
}
