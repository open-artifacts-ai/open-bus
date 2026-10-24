import { BusEventSchema, R } from "@ob/shared";
import { ApiError } from "../http/errors.js";
import { hubFetch } from "../hub/stub.js";
import { requireOwner } from "./me.js";
import type { AppType } from "./types.js";

const enc = new TextEncoder();

/**
 * The dashboard's SSE stream: a pipe over the hub's observer socket (the hub
 * holds no timer and pushes only on change). Frames are data-only
 * (`data: <json>\n\n`); only hub messages that parse with BusEventSchema pass,
 * in hub order. The body is pull-driven: while the client is slow, at most the
 * latest frame per type waits (a later `machines` replaces the pending one in
 * place), so memory never grows. A client abort closes the hub socket at once
 * (it frees an observer slot); a hub close (incl. 1013 eviction) ends the
 * stream after the pending frames, so EventSource reconnects.
 */
export function mountEvents(app: AppType): void {
  app.get(R.events, async (c) => {
    requireOwner(c);
    const res = await hubFetch(c.env, "/events", {
      headers: { Upgrade: "websocket" },
    });
    const ws = res.webSocket;
    if (res.status !== 101 || !ws)
      throw new ApiError("internal", "Hub did not upgrade");
    ws.accept();

    // type -> JSON text; Map keeps first-insertion order, so set() of a
    // pending type keeps its slot and hub order holds across types.
    const pending = new Map<string, string>();
    let ended = false;
    let wake: (() => void) | null = null;
    const signal = c.req.raw.signal;

    const poke = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const closeHub = () => {
      try {
        ws.close(1000, "client gone");
      } catch {
        // Already closed.
      }
    };
    const onAbort = () => finish(true);
    function finish(clientGone: boolean) {
      if (ended) return;
      ended = true;
      signal?.removeEventListener("abort", onAbort);
      if (clientGone) pending.clear();
      closeHub();
      poke();
    }

    ws.addEventListener("message", (ev) => {
      if (ended || typeof ev.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = BusEventSchema.safeParse(raw);
      if (!p.success) return;
      pending.set(p.data.type, JSON.stringify(p.data));
      poke();
    });
    ws.addEventListener("close", () => finish(false));
    ws.addEventListener("error", () => finish(false));
    if (signal?.aborted) finish(true);
    else signal?.addEventListener("abort", onAbort);

    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          while (pending.size === 0 && !ended)
            await new Promise<void>((r) => {
              wake = r;
            });
          const first = pending.entries().next();
          if (!first.done) {
            const [type, json] = first.value;
            pending.delete(type);
            controller.enqueue(enc.encode(`data: ${json}\n\n`));
            return;
          }
          try {
            controller.close();
          } catch {
            // Cancelled: the stream is already closed.
          }
        },
        cancel() {
          finish(true);
        },
      },
      // Pull only when the client reads: nothing queues inside the stream.
      { highWaterMark: 0 },
    );

    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  });
}
