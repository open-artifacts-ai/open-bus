import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { InjectError, inject } from "@ob/adapter-claude-code";
import type { AgentRecord } from "../agents.ts";
import type { DeliverOutcome, Mail } from "../deliver.ts";
import { HeldStore } from "./held.ts";

type Detail = "denied" | "refused" | "expired" | "dropped";
type Status = "held" | "delivered" | Detail;
const STATUSES = new Set<string>([
  "held",
  "delivered",
  "denied",
  "refused",
  "expired",
  "dropped",
]);
/** The transport is closing: nothing more will be heard. */
const STOPPED = Symbol("stopped");
/** sun_path is 104 bytes on macOS (108 on Linux), NUL included. */
const MAX_SOCKET_PATH = 103;

type Sink = {
  key: string;
  path: string;
  server: Server;
  conns: Set<Socket>;
  agentRef: string;
  namespace: string;
  peerName: string;
  /** Claude's own socket: the only `from` this sink believes. */
  claudeFrom: string;
};

export type ClaudeTransportOptions = {
  /** Return sockets live here: 0700, each socket 0600. */
  socketsDir: string;
  /** Where to inject for a session right now; null when the session is gone. */
  target: (ref: string) => { socketPath: string; peerToken: string } | null;
  /** Production 2000 ms: how long a hold status may take to arrive. */
  statusWindowMs?: number;
  /** How long a held message waits for the user; the mail TTL bounds it anyway. */
  heldMs?: number;
  injectTimeoutMs?: number;
  /** Held msg_ids survive a restart here (0600); a restarted daemon never re-injects them. */
  heldFile?: string;
  log?: (msg: string) => void;
  /** A native reply from `agentRef`'s session to `peerName`. */
  onReply?: (agentRef: string, peerName: string, body: string) => void;
};

/**
 * Delivers into a Claude session's own UDS socket, from one return socket per
 * (session, remote peer); whatever arrives there routes back to that peer.
 *
 * 2.1.306 sends no peer_message_status on plain delivery (measured; the frame
 * exists only on the hold path). So: write the frame, wait the status window;
 * silence means delivered. `held` stays pending and acks only on `delivered`;
 * any other status is a refusal with that detail, never an ack.
 */
export class ClaudeTransport {
  #sinks = new Map<string, Promise<Sink>>();
  #inflight = new Map<string, Promise<DeliverOutcome>>();
  /** msg_id → the sink it was injected from: a status counts only there. */
  #expecting = new Map<string, string>();
  #waiting = new Map<string, (s: Status | typeof STOPPED) => void>();
  /** A status can arrive before the caller starts waiting; keep the latest. */
  #buffered = new Map<string, Status>();
  #closed = false;
  readonly #held: HeldStore | undefined;

  /** Why every delivery is refused, when the transport cannot work at all. */
  readonly #disabled: string | undefined;

  constructor(private readonly opts: ClaudeTransportOptions) {
    this.#held = opts.heldFile ? new HeldStore(opts.heldFile) : undefined;
    const sample = join(opts.socketsDir, "00000000.sock");
    if (Buffer.byteLength(sample) > MAX_SOCKET_PATH) {
      this.#disabled = `claude delivery disabled: return socket paths are too long for a unix socket (${Buffer.byteLength(sample)} > ${MAX_SOCKET_PATH} bytes under ${opts.socketsDir}); use a shorter OPENBUS_HOME`;
      opts.log?.(this.#disabled);
    }
  }

  /** Disk trouble with the held file is logged; the in-memory wait still guards this daemon. */
  #heldOp<T>(what: string, fn: (h: HeldStore) => T): T | undefined {
    if (!this.#held) return undefined;
    try {
      return fn(this.#held);
    } catch (e) {
      this.opts.log?.(
        `claude held file ${what} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return undefined;
    }
  }

  deliver(agent: AgentRecord, mail: Mail): Promise<DeliverOutcome> {
    const running = this.#inflight.get(mail.msg_id);
    if (running) return running; // a hub redelivery never injects twice
    const p = this.#deliver(agent, mail).finally(() => {
      this.#inflight.delete(mail.msg_id);
      this.#expecting.delete(mail.msg_id);
      this.#buffered.delete(mail.msg_id);
    });
    this.#inflight.set(mail.msg_id, p);
    return p;
  }

  async #deliver(agent: AgentRecord, mail: Mail): Promise<DeliverOutcome> {
    if (this.#closed) return { ok: false, reason: "timeout" };
    // Refused, not closed: the session is fine, this daemon cannot reach it.
    if (this.#disabled)
      return { ok: false, reason: "closed", cause: "dropped" };
    // Claude still holds the copy an earlier daemon injected: a second one would
    // double it, and that copy's status went to a socket that is gone.
    if (this.#heldOp("read", (h) => h.has(mail.msg_id)))
      return { ok: false, reason: "closed", cause: "expired" };
    const target = this.opts.target(agent.ref);
    if (!target) return { ok: false, reason: "closed" };

    let sink: Sink;
    try {
      sink = await this.#sink(agent.ref, mail.namespace, mail.from_name);
    } catch {
      return { ok: false, reason: "timeout" }; // our side failed; let the hub retry
    }
    sink.claudeFrom = `uds:${target.socketPath}`;
    this.#expecting.set(mail.msg_id, sink.key);
    try {
      await inject({
        socketPath: target.socketPath,
        peerToken: target.peerToken,
        fromSocket: sink.path,
        fromName: mail.from_name,
        msgId: mail.msg_id,
        text: mail.body,
        timeoutMs: this.opts.injectTimeoutMs,
      });
    } catch (e) {
      // Nothing listening: the session is gone. Anything after connecting: retry.
      return e instanceof InjectError && !e.connected
        ? { ok: false, reason: "closed" }
        : { ok: false, reason: "timeout" };
    }

    let st = await this.#waitFor(mail.msg_id, this.opts.statusWindowMs ?? 2000);
    if (st === undefined) return { ok: true }; // silence: a plain delivery
    if (st === "held") {
      // Stay pending; ack only when the user lets it through.
      this.#heldOp("write", (h) => h.add(mail.msg_id));
      do st = await this.#waitFor(mail.msg_id, this.opts.heldMs ?? 3_600_000);
      while (st === "held");
      st ??= "expired";
    }
    // Stopping keeps the held record, so the next daemon does not inject again.
    if (st === STOPPED) return { ok: false, reason: "timeout" };
    this.#heldOp("write", (h) => h.delete(mail.msg_id));
    if (st === "delivered") return { ok: true };
    return { ok: false, reason: "closed", cause: st };
  }

  #waitFor(
    msgId: string,
    ms: number,
  ): Promise<Status | undefined | typeof STOPPED> {
    return new Promise((resolve) => {
      const buffered = this.#buffered.get(msgId);
      if (buffered !== undefined) {
        this.#buffered.delete(msgId);
        resolve(buffered);
        return;
      }
      const timer = setTimeout(() => {
        this.#waiting.delete(msgId);
        resolve(undefined);
      }, ms);
      timer.unref();
      this.#waiting.set(msgId, (s) => {
        clearTimeout(timer);
        this.#waiting.delete(msgId);
        resolve(s);
      });
    });
  }

  #onStatus(sink: Sink, msgId: string, status: string): void {
    if (!STATUSES.has(status) || this.#expecting.get(msgId) !== sink.key)
      return;
    const waiter = this.#waiting.get(msgId);
    if (waiter) waiter(status as Status);
    else this.#buffered.set(msgId, status as Status);
  }

  #onLine(sink: Sink, line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    // Any same-uid process can dial a sink; only the session itself is believed.
    if (frame?.from !== sink.claudeFrom) return;
    if (frame.type === "control" && frame.action === "peer_message_status") {
      this.#onStatus(
        sink,
        String(frame.orig_msg_id ?? ""),
        String(frame.status),
      );
      return;
    }
    if (frame.type !== "user") return;
    const content = (frame.message as { content?: unknown } | undefined)
      ?.content;
    if (typeof content !== "string") return;
    const body = (
      content.match(
        /^\s*<cross-session-message\b[^>]*>([\s\S]*)<\/cross-session-message>\s*$/,
      )?.[1] ?? content
    ).trim();
    if (body) this.opts.onReply?.(sink.agentRef, sink.peerName, body);
  }

  /** A global session hears from alice@ns1 and alice@ns2 on different sockets. */
  #sink(agentRef: string, namespace: string, peerName: string): Promise<Sink> {
    const key = `${agentRef}\u0000${namespace}\u0000${peerName}`;
    let sink = this.#sinks.get(key);
    if (!sink) {
      sink = this.#listen(key, agentRef, namespace, peerName);
      this.#sinks.set(key, sink);
      sink.catch(() => this.#sinks.delete(key));
    }
    return sink;
  }

  async #listen(
    key: string,
    agentRef: string,
    namespace: string,
    peerName: string,
  ) {
    const path = join(this.opts.socketsDir, `${randomUUID().slice(0, 8)}.sock`);
    mkdirSync(this.opts.socketsDir, { recursive: true, mode: 0o700 });
    chmodSync(this.opts.socketsDir, 0o700);
    rmSync(path, { force: true });
    const conns = new Set<Socket>();
    const sink: Sink = {
      key,
      path,
      conns,
      agentRef,
      namespace,
      peerName,
      claudeFrom: "",
      server: createServer((sock) => {
        conns.add(sock);
        sock.on("close", () => conns.delete(sock));
        sock.on("error", () => {});
        createInterface({ input: sock }).on("line", (l) =>
          this.#onLine(sink, l),
        );
      }),
    };
    await new Promise<void>((resolve, reject) => {
      sink.server.once("error", reject);
      sink.server.listen(path, () => resolve());
    });
    chmodSync(path, 0o600);
    return sink;
  }

  /** The session is gone: its return sockets go with it. */
  async drop(agentRef: string): Promise<void> {
    const mine = [...this.#sinks.entries()].filter(([k]) =>
      k.startsWith(`${agentRef}\u0000`),
    );
    const keys = new Set(mine.map(([k]) => k));
    for (const k of keys) this.#sinks.delete(k);
    // A held message for a gone session will hear nothing more.
    for (const [msgId, k] of this.#expecting)
      if (keys.has(k)) this.#waiting.get(msgId)?.(STOPPED);
    await Promise.all(mine.map(([, s]) => s.then(shut, () => {})));
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const w of [...this.#waiting.values()]) w(STOPPED);
    const all = [...this.#sinks.values()];
    this.#sinks.clear();
    await Promise.all(all.map((s) => s.then(shut, () => {})));
  }
}

async function shut(sink: Sink): Promise<void> {
  for (const c of sink.conns) c.destroy();
  await new Promise<void>((r) => sink.server.close(() => r()));
  rmSync(sink.path, { force: true });
}
