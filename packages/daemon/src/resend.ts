import type { SendFrame } from "@ob/shared";
import type { Timer } from "./sent.ts";

/** How long a send that lost its link keeps being resent; well under the hub's 1 h dedupe window. */
export const RESEND_WINDOW_MS = 60_000;
/** Links a send may lose before it is given up on. */
export const RESEND_MAX_DROPS = 3;
/** First wait before a resend the hub rate-limited goes again; doubles each time. */
const LIMITED_BASE_MS = 1000;

type Entry = {
  frame: SendFrame;
  native: boolean;
  /** Links lost while this send had no receipt. */
  drops: number;
  /** The link it last went out on; a resend goes once per link. */
  link: number;
  /** Rate-limited resends so far. */
  limited: number;
  /** Cancels the window's timer. */
  stopExpire?: () => void;
  /** Cancels a rate-limited resend's timer. */
  stopRetry?: () => void;
};

const unrefTimer: Timer = (ms, fn) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

/**
 * Sends the hub has not answered yet. One whose link drops is kept, frame and
 * id unchanged, and resent once its sender is registered on the next link: the
 * hub dedupes on (sender, id), so a send it already took is never delivered
 * twice (B14). In memory only: a daemon restart forgets them.
 */
export class Resends {
  #all = new Map<string, Entry>();
  #link = 0;
  readonly #windowMs: number;
  readonly #maxDrops: number;
  readonly #after: Timer;

  constructor(
    private readonly opts: {
      /** Queues the frame, unchanged; false when the link is down. */
      send: (f: SendFrame) => boolean;
      /** Gave up on a send: no answer comes for it. */
      expire: (f: SendFrame, native: boolean) => void;
      windowMs?: number;
      maxDrops?: number;
      after?: Timer;
      log?: (msg: string) => void;
    },
  ) {
    this.#windowMs = opts.windowMs ?? RESEND_WINDOW_MS;
    this.#maxDrops = opts.maxDrops ?? RESEND_MAX_DROPS;
    this.#after = opts.after ?? unrefTimer;
  }

  /** A send handed to the hub on the current link. */
  track(frame: SendFrame, native: boolean): void {
    this.#all.set(frame.id, {
      frame,
      native,
      drops: 0,
      link: this.#link,
      limited: 0,
    });
  }

  /** The hub answered it, or it never went out: no resend. */
  untrack(id: string): void {
    const e = this.#all.get(id);
    if (!e) return;
    e.stopExpire?.();
    e.stopRetry?.();
    this.#all.delete(id);
  }

  /** It went out on a link that dropped before the hub answered. */
  held(id: string): boolean {
    return (this.#all.get(id)?.drops ?? 0) > 0;
  }

  /** The link dropped: every unanswered send waits for the next one. */
  dropped(): void {
    this.#link++;
    for (const [id, e] of [...this.#all]) {
      e.stopRetry?.();
      e.stopRetry = undefined;
      if (++e.drops > this.#maxDrops) {
        this.#giveUp(id, e);
        continue;
      }
      e.stopExpire ??= this.#after(this.#windowMs, () => {
        e.stopExpire = undefined;
        this.#giveUp(id, e);
      });
    }
  }

  /** `ref` is registered on the current link: its held sends go again. */
  up(ref: string): void {
    for (const e of this.#all.values())
      if (e.drops > 0 && e.link !== this.#link && e.frame.from_ref === ref) {
        e.link = this.#link;
        this.opts.send(e.frame);
      }
  }

  /** The hub rate-limited a resend: it goes again later, within the window. False when not a resend. */
  limited(id: string): boolean {
    const e = this.#all.get(id);
    if (!e || e.drops === 0) return false;
    const link = this.#link;
    e.stopRetry?.();
    e.stopRetry = this.#after(LIMITED_BASE_MS * 2 ** e.limited++, () => {
      e.stopRetry = undefined;
      // A dropped link resends on the next agent_ok instead.
      if (link === this.#link) this.opts.send(e.frame);
    });
    return true;
  }

  /** The daemon is stopping: forget everything, timers included. */
  stop(): void {
    for (const id of [...this.#all.keys()]) this.untrack(id);
  }

  #giveUp(id: string, e: Entry): void {
    this.untrack(id);
    this.opts.log?.(
      `gave up resending ${id}: no receipt after ${e.drops} lost link(s)`,
    );
    this.opts.expire(e.frame, e.native);
  }
}
