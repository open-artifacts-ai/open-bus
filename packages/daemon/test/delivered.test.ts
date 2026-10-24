import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonStatus } from "@ob/ipc";
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

/** The hub replays missed receipt_updates after agent_up on reconnect (B6). */
describe("replayed receipt_updates after a reconnect", () => {
  const sentFile = () =>
    join(mkdtempSync(join(tmpdir(), "ob-sent-")), "sent.json");
  const reconnect = async (h: Awaited<ReturnType<typeof daemonHarness>>) => {
    const ups = h.of("agent_up").length;
    h.hubSock()?.terminate();
    await h.next("agent_up", ups + 1);
  };
  const update = (state: string, id = "u1") => ({
    type: "receipt_update",
    id,
    msg_id: ID,
    state,
  });

  it("records a replayed delivered and never notices it", async () => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const file = sentFile();
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: file,
    });
    await expect(queued(h)).resolves.toMatchObject({ state: "pending" });
    await reconnect(h);
    h.toDaemon(update("delivered"));
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(file, "utf8"))[ID]).toMatchObject({
        delivered: true,
      }),
    );
    // Replayed again, and an expiry after it: still nothing.
    h.toDaemon(update("delivered", "u2"));
    h.toDaemon(update("expired", "u3"));
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).not.toHaveBeenCalled();
  });

  it("notices a replayed expiry once, and never one already told", async () => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: sentFile(),
    });
    await expect(queued(h)).resolves.toMatchObject({ state: "pending" });
    await reconnect(h);
    h.toDaemon(update("expired"));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][1]).toMatch(
      /^×\s+Expired: your message to peer/,
    );
    // A second reconnect replays it again: already told, so no second notice.
    await reconnect(h);
    h.toDaemon(update("expired", "u2"));
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notices a replayed refusal once, and never one already settled", async () => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: sentFile(),
    });
    await expect(queued(h)).resolves.toMatchObject({ state: "pending" });
    h.toDaemon({ ...update("refused"), reason: "closed" });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    await reconnect(h);
    h.toDaemon({ ...update("refused", "u2"), reason: "closed" });
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("late deliveries are shown (C17 part 2)", () => {
  const LATE =
    '✓  Delivered: your message to peer, "hi",\n   was delivered after all.';

  it("rides once on the sender's next reply, never on another agent's", async () => {
    const h = await daemonHarness();
    const a = await h.adapter("A1");
    const b = await h.adapter("B1");
    expect(await queued(h)).toMatchObject({ state: "pending" });
    h.toDaemon({
      type: "receipt_update",
      id: "u1",
      msg_id: ID,
      state: "delivered",
    });
    await new Promise((r) => setTimeout(r, 100));
    // B asks first: A's late delivery is not B's.
    const bSelf = await b.request({ type: "self" });
    expect(bSelf).toMatchObject({ type: "agent" });
    expect(bSelf).not.toHaveProperty("late");
    const self = await a.request({ type: "self" });
    expect(self).toMatchObject({ type: "agent", late: [LATE] });
    const again = await a.request({ type: "self" });
    expect(again).not.toHaveProperty("late");
  });

  it("rides on an error reply too", async () => {
    const h = await daemonHarness();
    const a = await h.adapter("A1");
    expect(await queued(h)).toMatchObject({ state: "pending" });
    h.toDaemon({
      type: "receipt_update",
      id: "u1",
      msg_id: ID,
      state: "delivered",
    });
    await new Promise((r) => setTimeout(r, 100));
    const pendingErr = a.request({ type: "fetch", msg_id: ID2 });
    const f = await h.next("fetch");
    h.toDaemon({ type: "error", id: f.id, code: "not_found", message: "gone" });
    const err = await pendingErr;
    expect(err).toMatchObject({ type: "error", late: [LATE] });
  });

  it("a delivered inside the window is not late", async () => {
    const h = await daemonHarness({ deliveredWaitMs: WAIT });
    const a = await h.adapter("A1");
    const reply = queued(h);
    h.toDaemon({
      type: "receipt_update",
      id: "u1",
      msg_id: ID,
      state: "delivered",
    });
    expect(await reply).toMatchObject({ state: "delivered" });
    expect(await a.request({ type: "self" })).not.toHaveProperty("late");
    const st = await daemonStatus({ path: h.socketPath, timeoutMs: 3000 });
    expect(st.late ?? []).toEqual([]);
  });

  it("status lists late deliveries, read-only", async () => {
    const h = await daemonHarness();
    const a = await h.adapter("A1");
    expect(await queued(h)).toMatchObject({ state: "pending" });
    h.toDaemon({
      type: "receipt_update",
      id: "u1",
      msg_id: ID,
      state: "delivered",
    });
    await new Promise((r) => setTimeout(r, 100));
    const st = await daemonStatus({ path: h.socketPath, timeoutMs: 3000 });
    expect(st.late).toEqual([
      {
        from: expect.any(String),
        to: "peer",
        excerpt: "hi",
        at: expect.any(Number),
      },
    ]);
    // Status did not mark it shown.
    expect(await a.request({ type: "self" })).toMatchObject({ late: [LATE] });
  });
});
