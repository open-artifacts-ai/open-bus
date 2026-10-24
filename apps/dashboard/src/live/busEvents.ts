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
/** Close code the hub sends when the session ended. Never reconnect on it. */
const SESSION_ENDED = 4401;
const OPEN = 1;

/** Same origin as the page: wss on https, ws on http. */
export const eventsUrl = (loc: Pick<Location, "protocol" | "host">) =>
  `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}${R.events}`;

/**
 * One WebSocket for the page (a hibernatable socket on the hub). We do our own
 * backoff, so a refused upgrade (a signed-out session) stops instead of
 * hammering: a failure before the first `hello` parks the stream until
 * `retry()`. Only a `hello` resets the backoff, so a server that opens and
 * drops cannot be hit once a second. Every close reconnects (1013 evicted,
 * 1011 send failure, ...) except 4401, which signs out. The client never
 * sends anything but "ping".
 */
export function connectBusEvents(opts: BusEventsOptions) {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let idle = false;
  let hello = false;
  // A ping went out and its pong hasn't come back yet.
  let awaitingPong = false;

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

  /** `sock` is gone (closed by the hub, the network, or a missed pong). */
  const drop = (sock: WebSocket, code: number) => {
    if (ws !== sock || stopped) return;
    ws = null;
    awaitingPong = false;
    if (code === SESSION_ENDED) {
      stopped = true;
      clearInterval(ping);
      opts.onSignedOut();
      return;
    }
    opts.onDown();
    if (!hello) {
      idle = true;
      return;
    }
    schedule();
  };

  const open = () => {
    if (stopped || ws) return;
    idle = false;
    const sock = new WebSocket(eventsUrl(location));
    ws = sock;
    sock.onmessage = (m) => {
      if (ws !== sock) return;
      if (m.data === "pong") {
        awaitingPong = false;
        return;
      }
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
    // An error is always followed by a close; the close decides.
    sock.onclose = (e) => drop(sock, e.code);
  };

  const ping = setInterval(() => {
    const sock = ws;
    if (!sock || sock.readyState !== OPEN || hidden()) {
      awaitingPong = false;
      return;
    }
    if (awaitingPong) {
      // Half-open (a sleep, a dead NAT): treat it as a drop.
      sock.close(1000);
      drop(sock, 1006);
      return;
    }
    awaitingPong = true;
    sock.send("ping");
  }, PING_MS);

  timer = setTimeout(() => {
    timer = undefined;
    open();
  }, 0);
  return {
    /**
     * After a failed connect (a sleep, a focus): one more try now. Returns
     * whether it reconnected; a stream already open or backing off is left be.
     */
    retry(): boolean {
      if (stopped || !idle || ws) return false;
      open();
      return true;
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ping);
      const s = ws;
      ws = null;
      s?.close(1000);
    },
  };
}
