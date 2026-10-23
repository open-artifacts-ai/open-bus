import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotifyFn } from "../src/deliver.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const ID = "mmmmmmmmmmmmmmm1";
const sentFile = () =>
  join(mkdtempSync(join(tmpdir(), "ob-sent-")), "sent.json");

async function sentPending(h: Awaited<ReturnType<typeof daemonHarness>>) {
  const a = await h.adapter("A");
  const reply = a.request({ type: "send", to: "peer", body: "hi" });
  const sent = await h.next("send");
  h.toDaemon({ id: sent.id, type: "receipt", msg_id: ID, state: "pending" });
  await reply;
}

describe("receipt_update notices", () => {
  it.each([
    [{ state: "expired" }, "×  Expired: peer did not take it within 1 hour."],
    [
      { state: "expired", reason: "recipient_closed" },
      "×  Expired: peer closed before it was delivered.",
    ],
    [
      { state: "refused", reason: "closed" },
      "×  Refused (closed): peer did not accept it.\n   Send it again once the session is open, or message another agent.",
    ],
    [
      { state: "refused", reason: "ambiguous" },
      "×  Refused (ambiguous): peer exists in more than one namespace.\n   Send again with to_namespace set to one of them.",
    ],
  ])("tells the sending session when its mail is %o", async (update, text) => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: sentFile(),
    });
    await sentPending(h);
    h.toDaemon({ id: "u1", type: "receipt_update", msg_id: ID, ...update });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0]).toMatchObject({ ref: "A" });
    expect(notify.mock.calls[0][1]).toBe(text);
    // Told once: a repeated update is an unknown msg_id.
    h.toDaemon({ id: "u2", type: "receipt_update", msg_id: ID, ...update });
    await new Promise((r) => setTimeout(r, 50));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("stays silent on delivered and on an unknown msg_id", async () => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: sentFile(),
    });
    await sentPending(h);
    h.toDaemon({
      id: "u1",
      type: "receipt_update",
      msg_id: ID,
      state: "delivered",
    });
    h.toDaemon({
      id: "u2",
      type: "receipt_update",
      msg_id: "mmmmmmmmmmmmmmm9",
      state: "expired",
    });
    // After delivered the record is gone: a later expiry is unknown too.
    h.toDaemon({
      id: "u3",
      type: "receipt_update",
      msg_id: ID,
      state: "expired",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).not.toHaveBeenCalled();
  });

  it("still tells the sender after a daemon restart", async () => {
    const file = sentFile();
    const h1 = await daemonHarness({ sentFile: file });
    await sentPending(h1);
    await stopAll();
    const notify = vi.fn<NotifyFn>(async () => true);
    const h2 = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: file,
    });
    await h2.adapter("A");
    h2.toDaemon({
      id: "u1",
      type: "receipt_update",
      msg_id: ID,
      state: "expired",
      reason: "recipient_closed",
    });
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "A" }),
        "×  Expired: peer closed before it was delivered.",
      ),
    );
  });

  it("records nothing for a send refused at once", async () => {
    const notify = vi.fn<NotifyFn>(async () => true);
    const h = await daemonHarness({
      notifiers: { "claude-code": notify },
      sentFile: sentFile(),
    });
    const a = await h.adapter("A");
    const reply = a.request({ type: "send", to: "peer", body: "hi" });
    const sent = await h.next("send");
    h.toDaemon({
      id: sent.id,
      type: "receipt",
      msg_id: ID,
      state: "refused",
      reason: "unknown_agent",
    });
    await reply;
    h.toDaemon({
      id: "u1",
      type: "receipt_update",
      msg_id: ID,
      state: "expired",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).not.toHaveBeenCalled();
  });
});
