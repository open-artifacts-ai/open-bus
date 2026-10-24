import {
  type ClientFrame,
  decodeServerFrame,
  encodeFrame,
  frameId,
  PING,
  PONG,
  type ServerFrame,
} from "@ob/shared";
import WebSocket from "ws";

export type HubOptions = {
  url: string;
  token: string;
  label: string;
  version: string;
  /** Read on every open; sent as `sessions` right after `hello`. */
  sessions: () => { open: string[]; closed: string[] };
  onFrame: (frame: ServerFrame) => void;
  /** A frame the decoder rejected but whose id it recovered: it answers that request. */
  onBadFrame?: (id: string, error: "bad_frame" | "too_large") => void;
  onRevoked: () => void;
  onOpen: () => void;
  /** An open link dropped; requests in flight on it will not be answered. */
  onClose?: () => void;
  /** Debug log sink. Never receives the token. */
  log?: (msg: string) => void;
  /** Test seam: fixed delays. */
  backoffMs?: (attempt: number) => number;
  /** Keepalive interval; the link is dropped after two silent intervals. */
  pingMs?: number;
  handshakeTimeoutMs?: number;
  /** Open time after which a connection counts as stable and backoff resets. */
  stableMs?: number;
  /** Test seam: the frame encoder; default `encodeFrame`. */
  encode?: (frame: ClientFrame) => string;
};

export class HubConnection {
  #ws?: WebSocket;
  #attempt = 0;
  #stopped = false;
  #warned = false;
  #timer?: NodeJS.Timeout;
  reconnecting = false;
  /** Why the last attempt failed: a Node error code, `timeout` or `HTTP 502`. */
  lastError?: string;

  constructor(private readonly opts: HubOptions) {}

  start(): void {
    this.#stopped = false;
    if (this.#ws || this.#timer) return;
    this.#connect();
  }

  send(frame: ClientFrame): boolean {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false;
    let data: string;
    try {
      data = (this.opts.encode ?? encodeFrame)(frame);
    } catch (e) {
      // Like a closed socket: never sent, never a crash. The error's message
      // may quote the frame, so only its name is logged.
      this.opts.log?.(
        `could not encode a ${frame.type} frame (${frame.id}): ${e instanceof Error ? e.name : "error"}`,
      );
      return false;
    }
    this.#ws.send(data);
    return true;
  }

  get open(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  stop(): void {
    this.#stopped = true;
    this.reconnecting = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const ws = this.#ws;
    this.#ws = undefined;
    if (ws?.readyState === WebSocket.OPEN) ws.close();
    else ws?.terminate();
  }

  #guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.opts.log?.(
        `${what} threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  #revoke(): void {
    this.#stopped = true;
    this.reconnecting = false;
    this.#guard("onRevoked", () => this.opts.onRevoked());
  }

  #connect(): void {
    this.#timer = undefined;
    if (this.#stopped) return;
    const pingMs = this.opts.pingMs ?? 25_000;
    const ws = new WebSocket(this.opts.url, {
      headers: { authorization: `Bearer ${this.opts.token}` },
      handshakeTimeout: this.opts.handshakeTimeoutMs ?? 15_000,
    });
    this.#ws = ws;
    let lastRx = Date.now();
    let keepalive: NodeJS.Timeout | undefined;
    let stable: NodeJS.Timeout | undefined;
    const markStable = () => {
      this.#attempt = 0;
      clearTimeout(stable);
    };

    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      this.lastError = `HTTP ${res.statusCode}`;
      if (res.statusCode === 401 || res.statusCode === 403) {
        // A revoked token is refused at the upgrade, never with a 4403 close.
        this.#ws = undefined;
        this.#revoke();
      }
      ws.terminate();
    });
    ws.on("open", () => {
      this.reconnecting = false;
      this.lastError = undefined;
      lastRx = Date.now();
      this.send({
        v: 1,
        id: frameId(),
        type: "hello",
        machine_label: this.opts.label,
        client_version: this.opts.version,
      });
      this.#guard("sessions", () => {
        this.send({
          v: 1,
          id: frameId(),
          type: "sessions",
          ...this.opts.sessions(),
        });
      });
      this.#guard("onOpen", () => this.opts.onOpen());
      stable = setTimeout(markStable, this.opts.stableMs ?? 10_000);
      keepalive = setInterval(() => {
        if (Date.now() - lastRx > 2 * pingMs) {
          ws.terminate();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(PING);
      }, pingMs);
    });
    ws.on("message", (data) => {
      lastRx = Date.now();
      const text = String(data);
      if (text === PONG) return;
      const r = decodeServerFrame(text);
      if (!r.ok) {
        if (!this.#warned) {
          this.#warned = true;
          this.opts.log?.(`dropped ${r.error} frame from hub`);
        }
        const { id } = r;
        const bad = this.opts.onBadFrame;
        if (id !== undefined && bad)
          this.#guard("onBadFrame", () => bad(id, r.error));
        return;
      }
      markStable();
      this.#guard("onFrame", () => this.opts.onFrame(r.frame));
    });
    ws.on("close", (code) => {
      clearInterval(keepalive);
      clearTimeout(stable);
      if (this.#ws !== ws) return;
      this.#ws = undefined;
      if (this.opts.onClose) this.#guard("onClose", this.opts.onClose);
      if (code === 4403) {
        this.#revoke();
        return;
      }
      if (this.#stopped) return;
      this.reconnecting = true;
      const wait = (this.opts.backoffMs ?? defaultBackoff)(this.#attempt++);
      this.#timer = setTimeout(() => this.#connect(), wait);
    });
    ws.on("error", (e: NodeJS.ErrnoException) => {
      // Close follows; status shows why.
      if (!this.lastError?.startsWith("HTTP "))
        this.lastError = /timeout/i.test(e.message)
          ? "timeout"
          : (e.code ?? "error");
    });
  }
}

function defaultBackoff(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return Math.round(base * (0.5 + Math.random() / 2));
}
