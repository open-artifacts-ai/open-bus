import WebSocket from "ws";
import {
  type DaemonToHub,
  decodeServerFrame,
  type HubToDaemon,
} from "./wire.ts";

export type HubOptions = {
  url: string;
  token: string;
  label: string;
  version: string;
  /** Read on every open; sent as `sessions` right after `hello`. */
  sessions: () => { open: string[]; closed: string[] };
  onFrame: (frame: HubToDaemon) => void;
  onRevoked: () => void;
  onOpen: () => void;
  /** Debug log sink. Never receives the token. */
  log?: (msg: string) => void;
  /** Test seam: fixed delays. */
  backoffMs?: (attempt: number) => number;
};

export class HubConnection {
  #ws?: WebSocket;
  #attempt = 0;
  #stopped = false;
  #warned = false;
  #timer?: NodeJS.Timeout;
  reconnecting = false;

  constructor(private readonly opts: HubOptions) {}

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  send(frame: DaemonToHub): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(frame));
    }
  }

  get open(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  stop(): void {
    this.#stopped = true;
    this.reconnecting = false;
    clearTimeout(this.#timer);
    this.#ws?.close();
    this.#ws = undefined;
  }

  #connect(): void {
    if (this.#stopped) return;
    const ws = new WebSocket(this.opts.url, {
      headers: { authorization: `Bearer ${this.opts.token}` },
    });
    this.#ws = ws;

    ws.on("open", () => {
      this.#attempt = 0;
      this.reconnecting = false;
      this.send({
        v: 1,
        id: crypto.randomUUID(),
        type: "hello",
        machine_label: this.opts.label,
        client_version: this.opts.version,
      });
      this.send({
        v: 1,
        id: crypto.randomUUID(),
        type: "sessions",
        ...this.opts.sessions(),
      });
      this.opts.onOpen();
    });
    ws.on("message", (data) => {
      const r = decodeServerFrame(String(data));
      if (!r.ok) {
        if (!this.#warned) {
          this.#warned = true;
          this.opts.log?.(`dropped ${r.error} frame from hub`);
        }
        return;
      }
      try {
        this.opts.onFrame(r.frame);
      } catch (e) {
        this.opts.log?.(
          `onFrame threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });
    ws.on("close", (code) => {
      if (this.#ws !== ws) return;
      if (code === 4403) {
        this.#stopped = true;
        this.reconnecting = false;
        this.opts.onRevoked();
        return;
      }
      if (this.#stopped) return;
      this.reconnecting = true;
      const wait = (this.opts.backoffMs ?? defaultBackoff)(this.#attempt++);
      this.#timer = setTimeout(() => this.#connect(), wait);
    });
    ws.on("error", () => {
      /* close follows */
    });
  }
}

function defaultBackoff(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return Math.round(base * (0.5 + Math.random() / 2));
}
