import type { ClientFrame } from "@ob/shared";

/**
 * Lanes, highest first. `sessions` shares agent_up's lane so a later snapshot
 * never overtakes an agent_up queued before it; at open it follows hello anyway.
 */
const LANE: Partial<Record<ClientFrame["type"], number>> = {
  hello: 0,
  ack: 1,
  refuse: 1,
  agent_up: 2,
  agent_down: 2,
  sessions: 2,
};
const LANES = 4;

/**
 * Frames to the hub, paced under its per-socket limit (50 frames/s): a token
 * bucket of `burst` refilled at `rate`/s, so no second ever carries more than
 * burst + rate frames (40 by default). Bounded; overflow drops the oldest
 * frame of the lowest lane queued.
 */
export class FramePacer {
  #lanes: { frame: ClientFrame; data: string }[][] = Array.from(
    { length: LANES },
    () => [],
  );
  #tokens: number;
  #at: number;
  #timer?: NodeJS.Timeout;
  readonly #rate: number;
  readonly #burst: number;
  readonly #max: number;

  constructor(
    private readonly opts: {
      send: (data: string) => void;
      /** Tokens per second; default 35. */
      rate?: number;
      /** Bucket size; default 5. */
      burst?: number;
      /** Queued frames; default 1000. */
      max?: number;
      /** A queued frame dropped for space: its request will not be answered. */
      onDropped?: (frame: ClientFrame) => void;
      log?: (msg: string) => void;
    },
  ) {
    this.#rate = opts.rate ?? 35;
    this.#burst = opts.burst ?? 5;
    this.#max = opts.max ?? 1000;
    this.#tokens = this.#burst;
    this.#at = Date.now();
  }

  get size(): number {
    return this.#lanes.reduce((n, l) => n + l.length, 0);
  }

  /** False when the frame itself was dropped for space. */
  push(frame: ClientFrame, data: string): boolean {
    this.#lanes[LANE[frame.type] ?? LANES - 1].push({ frame, data });
    if (this.size > this.#max) {
      const lane = [...this.#lanes].reverse().find((l) => l.length > 0);
      const dropped = lane?.shift();
      if (dropped) {
        this.opts.log?.(
          `hub queue full: dropped a queued ${dropped.frame.type} frame (max ${this.#max})`,
        );
        if (dropped.frame === frame) return false;
        this.opts.onDropped?.(dropped.frame);
      }
    }
    this.#pump();
    return true;
  }

  clear(): void {
    for (const l of this.#lanes) l.length = 0;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #refill(): void {
    const now = Date.now();
    this.#tokens = Math.min(
      this.#burst,
      this.#tokens + ((now - this.#at) * this.#rate) / 1000,
    );
    this.#at = now;
  }

  #pump(): void {
    if (this.#timer) return;
    this.#refill();
    while (this.#tokens >= 1) {
      const next = this.#lanes.find((l) => l.length > 0)?.shift();
      if (!next) return;
      this.#tokens--;
      try {
        this.opts.send(next.data);
      } catch (e) {
        this.opts.log?.(
          `sending a ${next.frame.type} frame threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (this.size === 0) return;
    const wait = Math.ceil(((1 - this.#tokens) * 1000) / this.#rate);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#pump();
    }, wait);
    this.#timer.unref();
  }
}
