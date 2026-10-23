import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { AdapterFrame, type DaemonFrame, type Hello } from "./frames.ts";
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
  onClose?: (hello?: Hello) => void;
};

export type ServedDaemon = { close: () => Promise<void>; mode: number };

export async function serveDaemon(opts: ServeOptions): Promise<ServedDaemon> {
  const parent = dirname(opts.path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  rmSync(opts.path, { force: true });
  const server: Server = createServer((sock: Socket) => handle(sock, opts));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.path, () => resolve());
  });
  chmodSync(opts.path, 0o600);
  const mode = statSync(opts.path).mode & 0o777;
  return {
    mode,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        rmSync(opts.path, { force: true });
      }),
  };
}

function handle(sock: Socket, opts: ServeOptions) {
  const decoder = new LineDecoder();
  let hello: Hello | undefined;
  const send = (frame: Unframed & { id?: string }) => {
    const out = { ...frame, v: 1 as const, id: frame.id ?? "0" };
    sock.write(`${JSON.stringify(out)}\n`);
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
      const parsed = AdapterFrame.safeParse(raw);
      if (!parsed.success) {
        send({
          type: "error",
          id: "0",
          code: "bad_frame",
          message: parsed.error.message,
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
        const result = opts.onHello(frame);
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
      const reply = (f: DaemonFrame) => sock.write(`${JSON.stringify(f)}\n`);
      const replyNow = opts.onFrame(frame, hello, reply);
      if (replyNow) send({ ...replyNow, id: frame.id });
    }
  });
  sock.on("close", () => opts.onClose?.(hello));
  sock.on("error", () => {});
}
