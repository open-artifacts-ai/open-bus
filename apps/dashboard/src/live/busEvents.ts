import {
  type Agent,
  type BusEvent,
  BusEventSchema,
  type Machine,
  R,
} from "../api/contract";

const BASE_MS = 1_000;
const CAP_MS = 30_000;

export type Snapshot = { machines: Machine[] } | { agents: Agent[] };

/**
 * What to do with one frame: a snapshot to write into the cache, or null for
 * "don't guess" (hello, or a type this build doesn't know). The hook refetches
 * on null, so a deploy that adds frame types can never strand stale rows.
 */
export function patchFor(e: BusEvent): Snapshot | null {
  if (e.type === "machines") return { machines: e.machines };
  if (e.type === "agents") return { agents: e.agents };
  return null;
}

export type BusEventsOptions = {
  onHello(): void;
  onSnapshot(s: Snapshot): void;
  /** The stream dropped or never opened; the lists on screen are now stale. */
  onDown(): void;
  /** A frame we could not read: refetch rather than guess. */
  onUnknown(): void;
};

/**
 * One EventSource for the page. We do our own backoff instead of the browser's
 * built-in retry, so a 401 (a signed-out session) stops instead of hammering:
 * a failure before the first `hello` parks the stream until `retry()`.
 * Only a `hello` resets the backoff, so a server that opens and drops cannot
 * be hit once a second.
 */
export function connectBusEvents(opts: BusEventsOptions) {
  let es: EventSource | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let idle = false;
  let hello = false;

  /** A hidden tab never reconnects by itself: it parks until `retry()`. */
  const hidden = () => typeof document !== "undefined" && document.hidden;

  const schedule = () => {
    if (hidden()) {
      idle = true;
      return;
    }
    const delay = Math.min(CAP_MS, BASE_MS * 2 ** attempt++);
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      if (hidden()) {
        idle = true;
        return;
      }
      open();
    }, delay);
  };

  const open = () => {
    if (stopped || es) return;
    idle = false;
    const sock = new EventSource(R.events);
    es = sock;
    sock.onmessage = (m) => {
      if (es !== sock) return;
      let raw: unknown;
      try {
        raw = typeof m.data === "string" ? JSON.parse(m.data) : undefined;
      } catch {
        raw = undefined;
      }
      const f = BusEventSchema.safeParse(raw);
      if (!f.success) {
        opts.onUnknown();
        return;
      }
      if (f.data.type === "hello") {
        hello = true;
        attempt = 0;
        opts.onHello();
        return;
      }
      const p = patchFor(f.data);
      if (p) opts.onSnapshot(p);
      else opts.onUnknown();
    };
    sock.onerror = () => {
      if (es !== sock || stopped) return;
      es = null;
      sock.close();
      opts.onDown();
      if (!hello) {
        idle = true;
        return;
      }
      schedule();
    };
  };

  timer = setTimeout(() => {
    timer = undefined;
    open();
  }, 0);
  return {
    /** After a failed connect (a sleep, a focus): one more try now. */
    retry() {
      if (stopped || !idle || es) return;
      open();
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      const s = es;
      es = null;
      s?.close();
    },
  };
}
