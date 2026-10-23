/**
 * Frames that must reach the hub even if it is down right now (a Claude
 * session's native reply): bounded in count and age, flushed in order.
 */
export class Outbox<T> {
  #queue: { frame: T; at: number }[] = [];
  readonly #max: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;

  constructor(
    private readonly opts: {
      send: (frame: T) => boolean;
      max?: number;
      maxAgeMs?: number;
      now?: () => number;
      /** A frame whose sender is gone by flush time is dropped, not sent late. */
      stale?: (frame: T) => boolean;
      log?: (msg: string) => void;
    },
  ) {
    this.#max = opts.max ?? 100;
    this.#maxAgeMs = opts.maxAgeMs ?? 10 * 60_000;
    this.#now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.#queue.length;
  }

  push(frame: T): void {
    // Never overtake what is already waiting.
    if (this.#queue.length === 0 && this.opts.send(frame)) return;
    this.#queue.push({ frame, at: this.#now() });
    if (this.#queue.length > this.#max) {
      this.#queue.shift();
      this.opts.log?.(
        `outbox full: dropped the oldest queued frame (max ${this.#max})`,
      );
    }
  }

  flush(): void {
    const cutoff = this.#now() - this.#maxAgeMs;
    const fresh = this.#queue.filter((e) => e.at >= cutoff);
    const expired = this.#queue.length - fresh.length;
    if (expired)
      this.opts.log?.(`outbox: ${expired} queued frame(s) expired unsent`);
    const live = fresh.filter((e) => !this.opts.stale?.(e.frame));
    if (live.length < fresh.length)
      this.opts.log?.(
        `outbox: dropped ${fresh.length - live.length} queued frame(s) from agents no longer live`,
      );
    this.#queue = live;
    while (this.#queue.length > 0 && this.opts.send(this.#queue[0].frame))
      this.#queue.shift();
  }
}
