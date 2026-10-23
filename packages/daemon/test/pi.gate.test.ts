import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonFrame } from "@ob/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attest } from "../src/attest.ts";
import { daemonHarness, deliverFrame, hello, stopAll } from "./helpers.ts";

afterEach(stopAll);

const ID = "mmmmmmmmmmmmmmm1";
const settle = () => new Promise((r) => setTimeout(r, 60));
type Deliver = Extract<DaemonFrame, { type: "deliver" }>;

describe("pi gate: attest", () => {
  const pi = (proc_start?: string) =>
    hello({
      kind: "pi",
      agent_ref: "s1",
      attest: proc_start ? { proc_start } : {},
    });
  it("refuses a pi agent whose process is gone", () => {
    expect(attest(pi("t"), { procStart: () => null })).toEqual({
      ok: false,
      reason: "pi process is not running",
    });
  });
  it("refuses a reused pid", () => {
    expect(attest(pi("old"), { procStart: () => "new" })).toEqual({
      ok: false,
      reason: "pi process start time moved",
    });
  });
  it("refuses a hello with no proc_start", () => {
    expect(attest(pi(), { procStart: () => "t" })).toMatchObject({
      ok: false,
    });
  });
  it("accepts a live pi process", () => {
    expect(attest(pi("t"), { procStart: () => "t" })).toEqual({ ok: true });
  });
});

describe("pi gate: delivery on the extension's connection", () => {
  it("pushes to the session and acks the hub once the extension acks", async () => {
    const h = await daemonHarness();
    const a = await h.adapter("A", { kind: "pi" });
    const got: Deliver[] = [];
    a.onDeliver((f) => {
      got.push(f);
      a.ack(f.msg_id);
    });
    h.toDaemon(deliverFrame(ID));
    expect(await h.next("ack")).toMatchObject({ msg_id: ID });
    expect(got).toEqual([
      expect.objectContaining({ msg_id: ID, from_name: "peer", body: "hi" }),
    ]);
    await settle();
    expect(h.of("ack")).toHaveLength(1);
    expect(h.of("refuse")).toEqual([]);
  });

  it("after the session shuts down a delivery is refused closed and nothing is pushed", async () => {
    const h = await daemonHarness();
    const a = await h.adapter("A", { kind: "pi" });
    const got: Deliver[] = [];
    a.onDeliver((f) => got.push(f));
    const before = h.of("sessions").length;
    a.close();
    expect(await h.next("sessions", before + 1)).toMatchObject({
      closed: ["A"],
    });
    h.toDaemon(deliverFrame(ID));
    expect(await h.next("refuse")).toMatchObject({
      msg_id: ID,
      reason: "closed",
    });
    await settle();
    expect(got).toEqual([]);
    expect(h.of("ack")).toEqual([]);
  });

  it("an ack from another agent cannot confirm a pi delivery", async () => {
    const h = await daemonHarness({ pi: { ackTimeoutMs: 150 } });
    const a = await h.adapter("A", { kind: "pi" });
    const b = await h.adapter("B", { kind: "pi" });
    a.onDeliver(() => {
      b.ack(ID);
    });
    h.toDaemon(deliverFrame(ID));
    await settle();
    expect(h.of("ack")).toEqual([]);
    // Unacked, the attempt times out: no ack, no refuse; the hub retries.
    await new Promise((r) => setTimeout(r, 200));
    expect(h.of("ack")).toEqual([]);
    expect(h.of("refuse")).toEqual([]);
  });
});

describe("pi gate: notices", () => {
  const sentFile = () =>
    join(mkdtempSync(join(tmpdir(), "ob-sent-")), "sent.json");

  it("an expired or refused send is told to the pi sender on its connection", async () => {
    const h = await daemonHarness({ sentFile: sentFile() });
    const a = await h.adapter("A", { kind: "pi" });
    const notices: string[] = [];
    a.onNotice((t) => notices.push(t));
    const reply = a.request({ type: "send", to: "peer", body: "hi" });
    const sent = await h.next("send");
    h.toDaemon({ id: sent.id, type: "receipt", msg_id: ID, state: "pending" });
    await reply;
    h.toDaemon({
      id: "u1",
      type: "receipt_update",
      msg_id: ID,
      state: "refused",
      reason: "closed",
    });
    await vi.waitFor(() =>
      expect(notices).toEqual([
        "×  Refused (closed): peer did not accept it.\n   Send it again once the session is open, or message another agent.",
      ]),
    );
  });

  it("a notice owed while the pi sender was gone is told when it reconnects", async () => {
    const h = await daemonHarness({ sentFile: sentFile() });
    const a = await h.adapter("A", { kind: "pi" });
    const reply = a.request({ type: "send", to: "peer", body: "hi" });
    const sent = await h.next("send");
    h.toDaemon({ id: sent.id, type: "receipt", msg_id: ID, state: "pending" });
    await reply;
    a.close();
    await settle();
    h.toDaemon({
      id: "u1",
      type: "receipt_update",
      msg_id: ID,
      state: "expired",
    });
    await settle();
    const again = await h.adapter("A", { kind: "pi" });
    const notices: string[] = [];
    again.onNotice((t) => notices.push(t));
    await vi.waitFor(() =>
      expect(notices).toEqual([
        "×  Expired: peer did not take it within 1 hour.",
      ]),
    );
  });
});
