import type { DaemonFrame } from "@ob/ipc";
import type { AgentRecord } from "../agents.ts";
import type { DeliverOutcome, Mail } from "../deliver.ts";

export type PiTransportOptions = {
  /** Writes a frame on the session's live adapter connection; false when it has none. */
  push: (agentRef: string, frame: DaemonFrame) => boolean;
  /** How long the extension has to call pi.sendMessage and ack. Default 10 s. */
  ackTimeoutMs?: number;
};

/**
 * Pi receives on its extension's live connection: the daemon pushes the
 * message, the extension hands it to pi.sendMessage and acks. Only that ack,
 * from the session the message was pushed to, makes it delivered.
 */
export class PiTransport {
  #waiting = new Map<string, { ref: string; done: (ok: boolean) => void }>();

  constructor(private readonly opts: PiTransportOptions) {}

  async deliver(agent: AgentRecord, mail: Mail): Promise<DeliverOutcome> {
    const pushed = this.opts.push(agent.ref, {
      v: 1,
      id: `deliver-${mail.msg_id}`,
      type: "deliver",
      msg_id: mail.msg_id,
      from_name: mail.from_name,
      namespace: mail.namespace,
      ...(mail.notice ? { notice: mail.notice } : { body: mail.body }),
    });
    if (!pushed) return { ok: false, reason: "closed" };
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(mail.msg_id);
        resolve(false);
      }, this.opts.ackTimeoutMs ?? 10_000);
      timer.unref();
      this.#waiting.set(mail.msg_id, {
        ref: agent.ref,
        done: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
    });
    return ok ? { ok: true } : { ok: false, reason: "timeout" };
  }

  /** The extension acked msgId; true only for a push to that same session still waiting. */
  acked(msgId: string, ref: string): boolean {
    const w = this.#waiting.get(msgId);
    if (w?.ref !== ref) return false;
    this.#waiting.delete(msgId);
    w.done(true);
    return true;
  }

  /** An OpenBus notice (expired or refused mail); never a message from a peer. */
  async notify(agent: AgentRecord, text: string): Promise<boolean> {
    return this.opts.push(agent.ref, {
      v: 1,
      id: "0",
      type: "notice",
      text,
    });
  }
}
