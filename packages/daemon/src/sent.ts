import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { excerptOf } from "@ob/ipc";
import {
  AgentRefSchema,
  BusNameSchema,
  LIMITS,
  MsgIdSchema,
  type ReceiptReason,
  ReceiptReasonSchema,
  type ReceiptState,
  type SendFrame,
  WireNamespaceSchema,
} from "@ob/shared";

/** Who sent a message, so a later expiry or refusal reaches that session. */
export type SentMeta = {
  from_ref: string;
  to_name: string;
  namespace?: string;
  /** What the notice quotes of the body (`excerptOf`); absent in old entries. */
  excerpt?: string;
};
/** A final expired/refused receipt the sender has not been told yet. */
export type Outcome = { state: "expired" | "refused"; reason?: ReceiptReason };
/** `delivered`: the hub delivered it; kept for the sender to look up, never a notice. */
type Entry = SentMeta & { at: number; outcome?: Outcome; delivered?: true };

const validOutcome = (o: unknown): o is Outcome => {
  if (o === undefined) return true;
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return (
    (r.state === "expired" || r.state === "refused") &&
    (r.reason === undefined || ReceiptReasonSchema.safeParse(r.reason).success)
  );
};

const valid = (id: string, e: unknown): e is Entry => {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  return (
    MsgIdSchema.safeParse(id).success &&
    AgentRefSchema.safeParse(r.from_ref).success &&
    BusNameSchema.safeParse(r.to_name).success &&
    (r.namespace === undefined ||
      WireNamespaceSchema.safeParse(r.namespace).success) &&
    typeof r.at === "number" &&
    validOutcome(r.outcome) &&
    (r.delivered === undefined || r.delivered === true)
  );
};

/** An excerpt as stored: one line, at most 40 characters and an ellipsis, no quotes. */
const validExcerpt = (x: unknown): x is string =>
  typeof x === "string" &&
  x.length > 0 &&
  Array.from(x).length <= 41 &&
  !/["\r\n]/.test(x);

/**
 * Outgoing msg_ids not yet told to their sender, kept on disk (0600, written
 * atomically, batched per tick) so a restarted daemon still tells the sender.
 * An entry lives a little past the mail TTL, so the hub's expiry always finds
 * it; one with an outcome waits there for its sender to be live again.
 */
export class SentStore {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;
  readonly #log: ((msg: string) => void) | undefined;
  #all = new Map<string, Entry>();
  #dirty: NodeJS.Immediate | undefined;

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

  add(msgId: string, meta: SentMeta, outcome?: Outcome): void {
    this.#prune();
    this.#all.delete(msgId);
    this.#all.set(msgId, {
      ...meta,
      at: this.#now(),
      ...(outcome ? { outcome } : {}),
    });
    this.#cap();
    this.#save();
  }

  /** The sender of `msgId`; undefined when unknown or too old. */
  get(msgId: string): SentMeta | undefined {
    const e = this.#all.get(msgId);
    if (!e || e.at < this.#now() - this.#ttlMs) return undefined;
    const { at: _, outcome: __, delivered: ___, ...meta } = e;
    return meta;
  }

  /** Records that the hub delivered `msgId`; kept a full TTL from now. */
  deliver(msgId: string): void {
    const e = this.#all.get(msgId);
    if (!e) return;
    const { outcome: _, ...rest } = e;
    this.#all.delete(msgId);
    this.#all.set(msgId, { ...rest, at: this.#now(), delivered: true });
    this.#save();
  }

  isDelivered(msgId: string): boolean {
    return this.#all.get(msgId)?.delivered === true;
  }

  /** Messages from `ref` the hub delivered, oldest first. */
  delivered(ref: string): { msgId: string; meta: SentMeta }[] {
    this.#prune();
    const out: { msgId: string; meta: SentMeta }[] = [];
    for (const [msgId, e] of this.#all) {
      if (e.from_ref !== ref || !e.delivered) continue;
      const { at: _, outcome: __, delivered: ___, ...meta } = e;
      out.push({ msgId, meta });
    }
    return out;
  }

  /** Records the final receipt until the sender has been told. */
  /** The owed notice lives a full TTL from now, and moves to the back of the age order. */
  settle(msgId: string, outcome: Outcome): void {
    const e = this.#all.get(msgId);
    if (!e) return;
    this.#all.delete(msgId);
    this.#all.set(msgId, { ...e, at: this.#now(), outcome });
    this.#save();
  }

  delete(msgId: string): void {
    if (this.#all.delete(msgId)) this.#save();
  }

  /** Settled entries whose sender is `ref`, oldest first. */
  untold(ref: string): { msgId: string; meta: SentMeta; outcome: Outcome }[] {
    this.#prune();
    const out: { msgId: string; meta: SentMeta; outcome: Outcome }[] = [];
    for (const [msgId, e] of this.#all) {
      if (e.from_ref !== ref || !e.outcome) continue;
      const { at: _, outcome, ...meta } = e;
      out.push({ msgId, meta, outcome });
    }
    return out;
  }

  /** Writes now; a stopping daemon calls this so nothing batched is lost. */
  flush(): void {
    if (!this.#dirty) return;
    clearImmediate(this.#dirty);
    this.#dirty = undefined;
    this.#write();
  }

  /** Insertion order is age order: the first key is the oldest. */
  #cap(): void {
    while (this.#all.size > this.#max)
      this.#all.delete(this.#all.keys().next().value as string);
  }

  #prune(): void {
    const cutoff = this.#now() - this.#ttlMs;
    let pruned = false;
    for (const [id, e] of this.#all)
      if (e.at < cutoff) pruned = this.#all.delete(id);
    if (pruned) this.#save();
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
      const { from_ref, to_name, namespace, excerpt, at, outcome, delivered } =
        e as Entry;
      this.#all.set(id, {
        from_ref,
        to_name,
        ...(namespace === undefined ? {} : { namespace }),
        ...(validExcerpt(excerpt) ? { excerpt } : {}),
        at,
        ...(outcome
          ? {
              outcome: {
                state: outcome.state,
                ...(outcome.reason ? { reason: outcome.reason } : {}),
              },
            }
          : {}),
        ...(delivered ? { delivered } : {}),
      });
    }
    this.#prune();
    this.#cap();
  }

  /** One write per tick, however many changes it saw. */
  #save(): void {
    if (!this.file || this.#dirty) return;
    this.#dirty = setImmediate(() => {
      this.#dirty = undefined;
      this.#write();
    });
    this.#dirty.unref();
  }

  /** Disk trouble is logged; memory still serves this daemon's lifetime. */
  #write(): void {
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

export type Notice = { msgId: string; meta: SentMeta } & Outcome;
type Final = { msg_id: string; state: ReceiptState; reason?: ReceiptReason };

/** How long a tool call's send waits past its receipt for delivered (or a refusal or expiry). */
export const DELIVERED_WAIT_MS = 5000;

/** How long a receipt_update may wait for its own send's receipt. */
const EARLY_MS = 60_000;
const EARLY_MAX = 1000;

/**
 * Links a `send` to its hub receipt, then the receipt's msg_id to its later
 * `receipt_update`. Returns what the sending session must be told, if
 * anything; the notice stays in the store until `told`.
 */
export class Receipts {
  /** Hub frame id → the send waiting for its receipt. Short-lived. */
  #sending = new Map<string, { meta: SentMeta; native: boolean; at: number }>();
  /** msg_id → a receipt_update that beat its send's receipt. */
  #early = new Map<string, Final & { at: number }>();
  /** msg_id → a tool call's send waiting for its final receipt (`final`), or that final if it came first. */
  #waiting = new Map<
    string,
    { final?: Final; done?: (f: Final | undefined) => void }
  >();
  readonly #now: () => number;

  constructor(
    private readonly store: SentStore,
    opts: { now?: () => number } = {},
  ) {
    this.#now = opts.now ?? Date.now;
  }

  /** `native`: no tool call waits for this receipt, so a refusal is a notice too. */
  sending(f: SendFrame, namespace: string | undefined, native: boolean): void {
    const excerpt = typeof f.body === "string" ? excerptOf(f.body) : undefined;
    const cutoff = this.#now() - 15 * 60_000;
    for (const [id, s] of this.#sending)
      if (s.at < cutoff) this.#sending.delete(id);
    this.#sending.set(f.id, {
      meta: {
        from_ref: f.from_ref,
        to_name: f.to_name,
        ...(namespace ? { namespace } : {}),
        ...(excerpt ? { excerpt } : {}),
      },
      native,
      at: this.#now(),
    });
  }

  /** The hub answered this send with an error (or an undecodable frame): no receipt follows. */
  forget(frameId: string): void {
    this.#sending.delete(frameId);
  }

  /** `waits`: a tool call is about to wait on this send with `final`. */
  receipt(f: { id: string } & Final, waits = false): Notice | undefined {
    const s = this.#sending.get(f.id);
    if (!s) return undefined;
    this.#sending.delete(f.id);
    if (f.state === "pending") {
      this.store.add(f.msg_id, s.meta);
      if (waits) this.#waiting.set(f.msg_id, {});
      const early = this.#early.get(f.msg_id);
      if (!early) return undefined;
      this.#early.delete(f.msg_id);
      return early.at >= this.#now() - EARLY_MS
        ? this.update(early)
        : undefined;
    }
    if (!s.native || f.state !== "refused") return undefined;
    const outcome: Outcome = { state: f.state, reason: f.reason };
    this.store.add(f.msg_id, s.meta, outcome);
    return { msgId: f.msg_id, meta: s.meta, ...outcome };
  }

  update(f: Final): Notice | undefined {
    if (f.state === "pending") return undefined;
    const meta = this.store.get(f.msg_id);
    if (!meta) {
      this.#keepEarly(f);
      return undefined;
    }
    // Nothing follows delivered.
    if (this.store.isDelivered(f.msg_id)) return undefined;
    if (f.state === "delivered") {
      this.store.deliver(f.msg_id);
      this.#answer(f);
      return undefined;
    }
    // The waiting tool call tells the sender: no notice.
    if (this.#answer(f)) {
      this.store.delete(f.msg_id);
      return undefined;
    }
    const outcome: Outcome = { state: f.state, reason: f.reason };
    this.store.settle(f.msg_id, outcome);
    return { msgId: f.msg_id, meta, ...outcome };
  }

  /**
   * The final receipt for a send `receipt` was told waits, once it comes;
   * undefined when none came within `ms` (or the hub link dropped).
   */
  final(msgId: string, ms: number): Promise<Final | undefined> {
    const w = this.#waiting.get(msgId);
    if (!w) return Promise.resolve(undefined);
    if (w.final) {
      this.#waiting.delete(msgId);
      return Promise.resolve(w.final);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => w.done?.(undefined), ms);
      timer.unref();
      w.done = (f) => {
        clearTimeout(timer);
        this.#waiting.delete(msgId);
        resolve(f);
      };
    });
  }

  /** The hub link dropped: every waiting send answers now, as it stands. */
  release(): void {
    for (const w of [...this.#waiting.values()]) w.done?.(undefined);
    this.#waiting.clear();
  }

  /** Hands `f` to the send waiting on it; false when none waits. */
  #answer(f: Final): boolean {
    const w = this.#waiting.get(f.msg_id);
    if (!w) return false;
    const final: Final = {
      msg_id: f.msg_id,
      state: f.state,
      ...(f.reason ? { reason: f.reason } : {}),
    };
    if (w.done) w.done(final);
    else w.final = final;
    return true;
  }

  /** The sender has been told: forget the message. */
  told(msgId: string): void {
    this.store.delete(msgId);
  }

  /** Notices still owed to `ref`, e.g. after a restart or while it was away. */
  owed(ref: string): Notice[] {
    return this.store
      .untold(ref)
      .map(({ msgId, meta, outcome }) => ({ msgId, meta, ...outcome }));
  }

  #keepEarly(f: Final): void {
    const cutoff = this.#now() - EARLY_MS;
    for (const [id, e] of this.#early)
      if (e.at < cutoff) this.#early.delete(id);
    this.#early.set(f.msg_id, { ...f, at: this.#now() });
    while (this.#early.size > EARLY_MAX)
      this.#early.delete(this.#early.keys().next().value as string);
  }
}
