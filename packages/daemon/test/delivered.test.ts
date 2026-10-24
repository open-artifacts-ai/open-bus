import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotifyFn } from "../src/deliver.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const ID = "mmmmmmmmmmmmmmm1";
const ID2 = "mmmmmmmmmmmmmmm2";
const WAIT = 400;

/** A tool call's send whose receipt came back pending; the reply is still out. */
async function queued(
  h: Awaited<ReturnType<typeof daemonHarness>>,
  msgId = ID,
  n = 1,
) {
  const a = await h.adapter(`A${n}`);
  const reply = a.request({ type: "send", to: "peer", body: "hi" });
  const sent = await h.next("send", n);
  h.toDaemon({ id: sent.id, type: "receipt", msg_id: msgId, state: "pending" });
  return reply;
}

describe("send_message waits for delivered (C17)", () => {
  it("answers delivered when it comes inside the window", async () => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      deliveredWaitMs: WAIT,
    });
    const reply = queued(h);
    h.toDaemon({
      type: "receipt_update",
      id: "u1",
      msg_id: ID,
      state: "delivered",
    });
    await expect(reply).resolves.toMatchObject({
      type: "receipt",
      msg_id: ID,
      state: "delivered",
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("answers queued at the window's end; a later delivered is no notice", async () => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      deliveredWaitMs: WAIT,
    });
    const t0 = Date.now();
    await expect(queued(h)).resolves.toMatchObject({ state: "pending" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(WAIT - 20);
    h.toDaemon({
      type: "receipt_update",
      id: "u1",
      msg_id: ID,
      state: "delivered",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    [{ state: "refused", reason: "closed" }],
    [{ state: "expired", reason: "recipient_closed" }],
  ])("answers %o inside the window, with no notice after", async (update) => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      deliveredWaitMs: WAIT,
    });
    const reply = queued(h);
    h.toDaemon({ type: "receipt_update", id: "u1", msg_id: ID, ...update });
    await expect(reply).resolves.toMatchObject({ msg_id: ID, ...update });
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).not.toHaveBeenCalled();
  });

  it("an update that beats the receipt answers the send", async () => {
    const h = await daemonHarness({ deliveredWaitMs: WAIT });
    const a = await h.adapter("A");
    const reply = a.request({ type: "send", to: "peer", body: "hi" });
    const sent = await h.next("send");
    h.toDaemon({
      type: "receipt_update",
      id: "u1",
      msg_id: ID,
      state: "delivered",
    });
    h.toDaemon({ id: sent.id, type: "receipt", msg_id: ID, state: "pending" });
    const t0 = Date.now();
    await expect(reply).resolves.toMatchObject({ state: "delivered" });
    expect(Date.now() - t0).toBeLessThan(WAIT);
  });

  it("two concurrent sends resolve independently", async () => {
    const h = await daemonHarness({ deliveredWaitMs: WAIT });
    const a = queued(h, ID, 1);
    const b = queued(h, ID2, 2);
    await h.next("send", 2);
    h.toDaemon({
      type: "receipt_update",
      id: "u2",
      msg_id: ID2,
      state: "delivered",
    });
    await expect(b).resolves.toMatchObject({ msg_id: ID2, state: "delivered" });
    await expect(a).resolves.toMatchObject({ msg_id: ID, state: "pending" });
  });

  it("a hub link drop during the wait answers queued at once", async () => {
    const h = await daemonHarness({ deliveredWaitMs: 5000 });
    const a = await h.adapter("A");
    const reply = a.request({ type: "send", to: "peer", body: "hi" });
    const sent = await h.next("send");
    h.toDaemon({ id: sent.id, type: "receipt", msg_id: ID, state: "pending" });
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    h.hubSock()?.terminate();
    await expect(reply).resolves.toMatchObject({ state: "pending" });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
