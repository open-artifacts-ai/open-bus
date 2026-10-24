import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  AdapterFrame,
  type DaemonFrame,
  type Hello,
  MAX_BODY_BYTES,
  type StatusReply,
  StatusRequest,
} from "./frames.ts";
import { FrameTooLarge, LineDecoder } from "./lines.ts";

/** A daemon frame without the envelope the server fills in; distributes over the union. */
export type Unframed<T = DaemonFrame> = T extends unknown
  ? Omit<T, "v" | "id">
  : never;

export type HelloResult = {
  bus_name: string;
  namespace: string;
  global: boolean;
};
export type ServeOptions = {
  path: string;
  onHello: (hello: Hello) => HelloResult | { error: string };
  /** Pushes a later answer on this connection, for requests the hub answers asynchronously. */
  onFrame: (
    frame: AdapterFrame,
    hello: Hello,
    reply: (f: DaemonFrame) => void,
  ) => Unframed | undefined;
  /** After the welcome is written: `push` writes later frames on this connection. */
  onOpen?: (hello: Hello, push: (f: DaemonFrame) => void) => void;
  onClose?: (hello?: Hello) => void;
  /** Answers a `status` request; without it, status needs a hello like anything else. */
  onStatus?: (
    req: StatusRequest,
  ) =>
    | Omit<StatusReply, "v" | "id" | "type">
    | Promise<Omit<StatusReply, "v" | "id" | "type">>;
};

export type ServedDaemon = { close: () => Promise<void>; mode: number };

/** Unlinks a socket file left by a dead daemon; throws EADDRINUSE if something still answers. */
async function clearStale(path: string): Promise<void> {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (!st.isSocket()) {
    throw Object.assign(new Error(`${path} exists and is not a socket`), {
      code: "ENOTSOCK",
    });
  }
  const live = await new Promise<boolean>((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
  if (live) {
    throw Object.assign(new Error(`daemon already listening on ${path}`), {
      code: "EADDRINUSE",
    });
  }
  rmSync(path, { force: true });
}

export async function serveDaemon(opts: ServeOptions): Promise<ServedDaemon> {
  const parent = dirname(opts.path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  await clearStale(opts.path);
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock: Socket) => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    handle(sock, opts);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.path, () => resolve());
  });
  chmodSync(opts.path, 0o600);
  const st = statSync(opts.path);
  const mode = st.mode & 0o777;
  return {
    mode,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        // libuv unlinks the path inside server.close() whatever is there. If
        // it is no longer our socket, park a hard link and put it back after.
        let parked: string | undefined;
        try {
          const now = statSync(opts.path);
          if (now.ino !== st.ino || now.dev !== st.dev) {
            parked = `${opts.path}.keep-${process.pid}`;
            linkSync(opts.path, parked);
          }
        } catch {}
        server.close(() => {
          if (parked) {
            try {
              renameSync(parked, opts.path);
            } catch {}
          }
          resolve();
        });
      }),
  };
}

function handle(sock: Socket, opts: ServeOptions) {
  const decoder = new LineDecoder();
  let hello: Hello | undefined;
  const send = (frame: Unframed & { id?: string }) => {
    if (sock.destroyed) return;
    const out = { ...frame, v: 1 as const, id: frame.id ?? "0" };
    sock.write(`${JSON.stringify(out)}\n`);
  };
  const push = (f: DaemonFrame) => {
    if (!sock.destroyed) sock.write(`${JSON.stringify(f)}\n`);
  };
  const fail = (id: string, message: string) => {
    send({ type: "error", id, code: "internal", message });
    sock.destroy();
  };

  sock.on("data", (chunk) => {
    let frames: unknown[];
    try {
      frames = decoder.push(chunk);
    } catch (e) {
      const code = e instanceof FrameTooLarge ? "frame_too_large" : "bad_frame";
      send({ type: "error", id: "0", code, message: String(e) });
      sock.destroy();
      return;
    }
    for (const raw of frames) {
      const status = opts.onStatus && StatusRequest.safeParse(raw);
      if (status?.success && opts.onStatus) {
        const { id } = status.data;
        const helloed = Boolean(hello);
        Promise.resolve()
          .then(() => opts.onStatus?.(status.data))
          .then(
            (r) => {
              if (r) send({ type: "status", id, ...r });
              if (!helloed) sock.end();
            },
            (e: unknown) =>
              fail(id, e instanceof Error ? e.message : String(e)),
          );
        continue;
      }
      const parsed = AdapterFrame.safeParse(raw);
      if (!parsed.success) {
        const r = raw as { id?: unknown; type?: unknown; body?: unknown };
        const id = typeof r?.id === "string" && r.id ? r.id.slice(0, 64) : "0";
        if (hello && id !== "0") {
          // Framing is intact, so after hello a bad request costs only itself.
          const tooLarge =
            r.type === "send" &&
            typeof r.body === "string" &&
            Buffer.byteLength(r.body, "utf8") > MAX_BODY_BYTES;
          send({
            type: "error",
            id,
            code: tooLarge ? "too_large" : "bad_frame",
            message: tooLarge
              ? "body too large"
              : (parsed.error.issues[0]?.message ?? "bad frame"),
          });
          continue;
        }
        send({
          type: "error",
          id,
          code: "bad_frame",
          message: parsed.error.issues[0]?.message ?? "bad frame",
        });
        sock.destroy();
        return;
      }
      const frame = parsed.data;
      if (!hello) {
        if (frame.type !== "hello") {
          send({
            type: "error",
            id: frame.id,
            code: "unauthorized",
            message: "hello first",
          });
          sock.destroy();
          return;
        }
        let result: ReturnType<ServeOptions["onHello"]>;
        try {
          result = opts.onHello(frame);
        } catch (e) {
          fail(frame.id, e instanceof Error ? e.message : String(e));
          return;
        }
        if ("error" in result) {
          send({
            type: "error",
            id: frame.id,
            code: "unauthorized",
            message: result.error,
          });
          sock.destroy();
          return;
        }
        hello = frame;
        send({
          type: "welcome",
          id: frame.id,
          agent_ref: frame.agent_ref,
          ...result,
        });
        try {
          opts.onOpen?.(frame, push);
        } catch (e) {
          fail(frame.id, e instanceof Error ? e.message : String(e));
          return;
        }
        continue;
      }
      if (frame.type === "hello") {
        send({
          type: "error",
          id: frame.id,
          code: "bad_frame",
          message: "already helloed",
        });
        sock.destroy();
        return;
      }
      try {
        const replyNow = opts.onFrame(frame, hello, push);
        if (replyNow) send({ ...replyNow, id: frame.id });
      } catch (e) {
        fail(frame.id, e instanceof Error ? e.message : String(e));
        return;
      }
    }
  });
  sock.on("close", () => opts.onClose?.(hello));
  sock.on("error", () => {});
}
