import { connect, type Socket } from "node:net";
import { DaemonFrame, type Hello } from "./frames.ts";
import { LineDecoder } from "./lines.ts";

export type DaemonClient = {
  welcome: Extract<DaemonFrame, { type: "welcome" }>;
  state: "open" | "closed";
  request: (frame: {
    type: "list" | "self" | "send" | "fetch";
    id?: string;
    to?: string;
    body?: string;
    msg_id?: string;
  }) => Promise<DaemonFrame>;
  /** Confirms a delivery was injected. Fire-and-forget: the daemon sends no reply. */
  ack: (msg_id: string) => void;
  onDeliver: (
    cb: (frame: Extract<DaemonFrame, { type: "deliver" }>) => void,
  ) => void;
  close: () => void;
};

export async function connectDaemon(opts: {
  path: string;
  hello: Hello;
  timeoutMs?: number;
  /** Receives errors thrown by the onDeliver callback; defaults to console.error. */
  onError?: (e: unknown) => void;
}): Promise<DaemonClient> {
  const sock: Socket = connect(opts.path);
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  const decoder = new LineDecoder();
  let state: "open" | "closed" = "open";
  let seq = 0;
  type Waiter = {
    resolve: (f: DaemonFrame) => void;
    reject: (e: Error) => void;
  };
  const pending = new Map<string, Waiter>();
  const waiters: Waiter[] = [];
  type Deliver = Extract<DaemonFrame, { type: "deliver" }>;
  let deliver: ((f: Deliver) => void) | undefined;
  const early: Deliver[] = [];
  const report =
    opts.onError ?? ((e: unknown) => console.error("onDeliver threw", e));
  const dispatch = (f: Deliver) => {
    try {
      deliver?.(f);
    } catch (e) {
      report(e);
    }
  };

  const failAll = (err: Error) => {
    state = "closed";
    for (const w of [...pending.values(), ...waiters.splice(0)]) w.reject(err);
    pending.clear();
  };

  sock.on("data", (chunk) => {
    try {
      for (const raw of decoder.push(chunk)) {
        const frame = DaemonFrame.parse(raw);
        if (frame.type === "deliver") {
          if (deliver) dispatch(frame);
          else early.push(frame);
          continue;
        }
        const waiter = pending.get(frame.id);
        if (waiter) {
          pending.delete(frame.id);
          waiter.resolve(frame);
          continue;
        }
        waiters.shift()?.resolve(frame);
      }
    } catch (e) {
      failAll(e instanceof Error ? e : new Error(String(e)));
      sock.destroy();
    }
  });
  sock.on("error", (e) => failAll(e));
  sock.on("close", () => failAll(new Error("daemon connection closed")));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const welcomeRaw = await new Promise<DaemonFrame>((resolve, reject) => {
    waiters.push({ resolve, reject });
    timer = setTimeout(() => {
      reject(new Error("daemon did not answer hello"));
      sock.destroy();
    }, opts.timeoutMs ?? 5000);
    sock.write(`${JSON.stringify(opts.hello)}\n`);
  }).finally(() => clearTimeout(timer));
  if (welcomeRaw.type !== "welcome") {
    sock.destroy();
    throw new Error(`daemon refused hello: ${JSON.stringify(welcomeRaw)}`);
  }
  const welcome = welcomeRaw;

  return {
    welcome,
    get state() {
      return state;
    },
    request: (partial) => {
      if (state === "closed")
        return Promise.reject(new Error("daemon connection closed"));
      const id = partial.id ?? String(++seq);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        sock.write(`${JSON.stringify({ v: 1, ...partial, id })}\n`);
      });
    },
    ack: (msg_id) => {
      if (state === "closed") return;
      sock.write(
        `${JSON.stringify({ v: 1, type: "ack", id: `ack-${++seq}`, msg_id })}\n`,
      );
    },
    onDeliver: (cb) => {
      deliver = cb;
      for (const f of early.splice(0)) dispatch(f);
    },
    close: () => sock.destroy(),
  };
}
