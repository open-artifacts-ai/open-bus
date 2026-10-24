/**
 * Stands in for the browser WebSocket (jsdom's would dial out, and msw's node
 * interceptor would answer it). Records instances and lets a test push frames,
 * open, fail or close the connection. setup.ts installs it before every test.
 */
export class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  /** The code the client closed with, or null while it hasn't. */
  closedWith: number | null = null;
  /** Every frame the client sent. */
  sent: unknown[] = [];
  /** Answer "ping" with "pong", as the hub's hibernation auto-response does. */
  autoPong = true;
  constructor(public url: string) {
    FakeWebSocket.all.push(this);
  }
  /** Closed by either side. */
  get closed() {
    return this.readyState === 3;
  }
  send(data: unknown) {
    if (this.readyState !== 1) throw new Error("send() before open");
    this.sent.push(data);
    if (this.autoPong && data === "ping") this.onmessage?.({ data: "pong" });
  }
  /** Like a browser: closing now, the close event a task later. */
  close(code?: number) {
    if (this.readyState === 3) return;
    this.closedWith = code ?? 1005;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code: code ?? 1005 }));
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  /** Server-side frame. */
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** A raw frame, valid JSON or not. */
  pushRaw(data: unknown) {
    this.onmessage?.({ data });
  }
  /** The server (or the network) closed it with `code`. */
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  /** The connection failed (a refused upgrade, a dead network): error, then close 1006. */
  fail() {
    this.readyState = 3;
    this.onerror?.({});
    this.onclose?.({ code: 1006 });
  }
}

/** Defined, not assigned: msw's interceptor leaves the global read-only. */
export const installFakeWebSocket = () => {
  FakeWebSocket.all = [];
  Object.defineProperty(globalThis, "WebSocket", {
    value: FakeWebSocket,
    writable: true,
    configurable: true,
  });
};

export const lastSocket = () => {
  const s = FakeWebSocket.all.at(-1);
  if (!s) throw new Error("no WebSocket was opened");
  return s;
};
