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
 * A frame's list snapshot to write into the cache, or null when it carries
 * none (hello never gets here: the stream handles it first). The stream
 * reports null as unknown and the hook refetches, so a frame type this build
 * can't patch never strands stale rows.
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
  /** The hub closed with 4401: the session is over (logout, revoke-all, expiry). */
  onSignedOut(): void;
};

/** Liveness probe period; the hub answers "ping" with "pong" while hibernating. */
export const PING_MS = 30_000;
/** How long a probe waits for any frame (a pong or anything else) back. */
export const PONG_GRACE_MS = 5_000;
/** How long a socket must stay up after its hello before the backoff resets. */
export const STABLE_MS = 10_000;
/** Close code the hub sends when the session ended. Never reconnect on it. */
const SESSION_ENDED = 4401;
const OPEN = 1;

/** Same origin as the page: wss on https, ws on http. */
export const eventsUrl = (loc: Pick<Location, "protocol" | "host">) =>
  `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}${R.events}`;

/**
 * One WebSocket for the page (a hibernatable socket on the hub). We do our own
 * backoff (1 s doubling to 30 s). Every close reconnects with it (1013
 * evicted, 1011 send failure, a refused upgrade, ...) except 4401, which signs
 * out. The backoff resets only once a socket has stayed up for 10 s after its
 * hello, so a server that greets and then drops cannot be hit once a second.
 * A hidden tab never reconnects by itself: it parks until `wake()`/`retry()`.
 * Liveness: "ping" every 30 s while visible, and at once on `wake()`; no
 * frame back within 5 s means the socket is dead. The client never sends
 * anything but "ping".
 */
export function connectBusEvents(opts: BusEventsOptions) {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stable: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let idle = false;

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

  const quiet = () => {
    clearTimeout(stable);
    stable = undefined;
    clearTimeout(watchdog);
    watchdog = undefined;
  };

  /** `sock` is gone (closed by the hub, the network, or a failed probe). */
  const drop = (sock: WebSocket, code: number) => {
    if (ws !== sock || stopped) return;
    ws = null;
    quiet();
    if (code === SESSION_ENDED) {
      stopped = true;
      clearInterval(ping);
      opts.onSignedOut();
      return;
    }
    opts.onDown();
    schedule();
  };

  /** Ping now and give the socket 5 s to send anything back. */
  const probe = () => {
    const sock = ws;
    if (!sock || sock.readyState !== OPEN || hidden() || watchdog) return;
    watchdog = setTimeout(() => {
      watchdog = undefined;
      // Half-open (a sleep, a dead NAT): treat it as a drop.
      sock.close(1000);
      drop(sock, 1006);
    }, PONG_GRACE_MS);
    sock.send("ping");
  };

  const open = () => {
    if (stopped || ws) return;
    idle = false;
    const sock = new WebSocket(eventsUrl(location));
    ws = sock;
    sock.onmessage = (m) => {
      if (ws !== sock) return;
      // Any frame proves the socket is alive.
      clearTimeout(watchdog);
      watchdog = undefined;
      if (m.data === "pong") return;
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
        clearTimeout(stable);
        stable = setTimeout(() => {
          stable = undefined;
          attempt = 0;
        }, STABLE_MS);
        opts.onHello();
        return;
      }
      const p = patchFor(f.data);
      if (p) opts.onSnapshot(p);
      else opts.onUnknown();
    };
    // An error is always followed by a close; the close decides.
    sock.onclose = (e) => drop(sock, e.code);
  };

  const ping = setInterval(probe, PING_MS);

  timer = setTimeout(() => {
    timer = undefined;
    open();
  }, 0);
  /**
   * One more connect now, if the stream is parked (hidden, or after a sleep).
   * With `now` (the Retry button) a pending backoff is cut short too. Returns
   * whether it connected; an open socket is left be.
   */
  const retry = (now = false): boolean => {
    if (stopped || ws) return false;
    if (!idle && !(now && timer)) return false;
    clearTimeout(timer);
    timer = undefined;
    open();
    return true;
  };
  return {
    retry,
    /** The tab is visible again: reconnect if parked, else probe the socket. */
    wake() {
      if (!retry()) probe();
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ping);
      quiet();
      const s = ws;
      ws = null;
      s?.close(1000);
    },
  };
}
