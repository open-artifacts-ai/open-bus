import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  AgentRefSchema,
  BusNameSchema,
  LIMITS,
  MsgIdSchema,
  type ReceiptReason,
  type ReceiptState,
  type SendFrame,
  WireNamespaceSchema,
} from "@ob/shared";

/** Who sent a message, so a later expiry or refusal reaches that session. */
export type SentMeta = {
  from_ref: string;
  to_name: string;
  namespace?: string;
};
type Entry = SentMeta & { at: number };

const valid = (id: string, e: unknown): e is Entry => {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  return (
    MsgIdSchema.safeParse(id).success &&
    AgentRefSchema.safeParse(r.from_ref).success &&
    BusNameSchema.safeParse(r.to_name).success &&
    (r.namespace === undefined ||
      WireNamespaceSchema.safeParse(r.namespace).success) &&
    typeof r.at === "number"
  );
};

/**
 * Outgoing msg_ids still pending at the hub, kept on disk (0600, written
 * atomically) so a restarted daemon still tells the sender. An entry lives a
 * little past the mail TTL, so the hub's expiry always finds it.
 */
export class SentStore {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;
  readonly #log: ((msg: string) => void) | undefined;
  #all = new Map<string, Entry>();

  constructor(
    private readonly file?: string,
    opts: {
      ttlMs?: number;
      max?: number;
      now?: () => number;
      log?: (msg: string) => void;
    } = {},
  ) {
    this.#ttlMs = opts.ttlMs ?? (LIMITS.mailTtlSec + 300) * 1000;
    this.#max = opts.max ?? 10_000;
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log;
    this.#load();
  }

  add(msgId: string, meta: SentMeta): void {
    this.#prune();
    this.#all.delete(msgId);
    this.#all.set(msgId, { ...meta, at: this.#now() });
    this.#cap();
    this.#save();
  }

  /** The sender of `msgId`, forgotten once read; undefined when unknown or too old. */
  take(msgId: string): SentMeta | undefined {
    const e = this.#all.get(msgId);
    if (!e) return undefined;
    this.#all.delete(msgId);
    this.#save();
    if (e.at < this.#now() - this.#ttlMs) return undefined;
    const { at: _, ...meta } = e;
    return meta;
  }

  /** Insertion order is age order: the first key is the oldest. */
  #cap(): void {
    while (this.#all.size > this.#max)
      this.#all.delete(this.#all.keys().next().value as string);
  }

  #prune(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [id, e] of this.#all) if (e.at < cutoff) this.#all.delete(id);
  }

  #load(): void {
    if (!this.file) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const entries = Object.entries(raw).filter(([id, e]) => valid(id, e));
    entries.sort(([, a], [, b]) => (a as Entry).at - (b as Entry).at);
    for (const [id, e] of entries) {
      const { from_ref, to_name, namespace, at } = e as Entry;
      this.#all.set(id, {
        from_ref,
        to_name,
        ...(namespace === undefined ? {} : { namespace }),
        at,
      });
    }
    this.#prune();
    this.#cap();
  }

  /** Disk trouble is logged; memory still serves this daemon's lifetime. */
  #save(): void {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      rmSync(tmp, { force: true });
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#all)), {
        mode: 0o600,
        flag: "wx",
      });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch (e) {
      this.#log?.(
        `sent file write failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

export type Notice = {
  meta: SentMeta;
  state: ReceiptState;
  reason?: ReceiptReason;
};

/**
 * Links a `send` to its hub receipt, then the receipt's msg_id to its later
 * `receipt_update`. Returns what the sending session must be told, if anything.
 */
export class Receipts {
  /** Hub frame id → the send waiting for its receipt. Short-lived. */
  #sending = new Map<string, { meta: SentMeta; native: boolean; at: number }>();
  readonly #now: () => number;

  constructor(
    private readonly store: SentStore,
    opts: { now?: () => number } = {},
  ) {
    this.#now = opts.now ?? Date.now;
  }

  /** `native`: no tool call waits for this receipt, so a refusal is a notice too. */
  sending(f: SendFrame, namespace: string | undefined, native: boolean): void {
    const cutoff = this.#now() - 15 * 60_000;
    for (const [id, s] of this.#sending)
      if (s.at < cutoff) this.#sending.delete(id);
    this.#sending.set(f.id, {
      meta: {
        from_ref: f.from_ref,
        to_name: f.to_name,
        ...(namespace ? { namespace } : {}),
      },
      native,
      at: this.#now(),
    });
  }

  receipt(f: {
    id: string;
    msg_id: string;
    state: ReceiptState;
    reason?: ReceiptReason;
  }): Notice | undefined {
    const s = this.#sending.get(f.id);
    if (!s) return undefined;
    this.#sending.delete(f.id);
    if (f.state === "pending") {
      this.store.add(f.msg_id, s.meta);
      return undefined;
    }
    return s.native && f.state === "refused"
      ? { meta: s.meta, state: f.state, reason: f.reason }
      : undefined;
  }

  update(f: {
    msg_id: string;
    state: ReceiptState;
    reason?: ReceiptReason;
  }): Notice | undefined {
    if (f.state === "pending") return undefined;
    const meta = this.store.take(f.msg_id);
    if (!meta || f.state === "delivered") return undefined;
    return { meta, state: f.state, reason: f.reason };
  }
}
