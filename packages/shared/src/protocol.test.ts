import { describe, expect, it } from "vitest";
import { LIMITS } from "./limits.js";
import {
  CLIENT_FRAMES,
  decodeFrame,
  encodeFrame,
  formatFrameError,
  SERVER_FRAMES,
} from "./protocol.js";

const id = "7Yb3kQmZ1xRt9PvA";

describe("frames", () => {
  it("round-trips a send and a deliver", () => {
    const send = {
      v: 1,
      id,
      type: "send",
      from_ref: "s1",
      to_name: "OpenBus Backend",
      body: "hi",
    } as const;
    expect(decodeFrame(encodeFrame(send))).toEqual(send);
    const deliver = {
      v: 1,
      id,
      type: "deliver",
      msg_id: "aaaaaaaaaaaaaaaa",
      to_ref: "s1",
      from_name: "Pi",
      namespace: "github.com/a/b",
      body: "hi",
    } as const;
    expect(decodeFrame(encodeFrame(deliver))).toEqual(deliver);
  });
  it("round-trips an oversized notice", () => {
    const f = {
      v: 1,
      id,
      type: "deliver",
      msg_id: "aaaaaaaaaaaaaaaa",
      to_ref: "s1",
      from_name: "Pi",
      namespace: "n",
      notice: { size: 40000, msg_id: "aaaaaaaaaaaaaaaa" },
    } as const;
    expect(decodeFrame(encodeFrame(f))).toEqual(f);
  });
  it("round-trips a refusal", () => {
    const f = {
      v: 1,
      id,
      type: "refuse",
      msg_id: "aaaaaaaaaaaaaaaa",
      reason: "closed",
      detail: "denied",
    } as const;
    expect(decodeFrame(encodeFrame(f))).toEqual(f);
    expect(decodeFrame(JSON.stringify({ ...f, detail: "held" }))).toBeNull();
    expect(
      decodeFrame(JSON.stringify({ ...f, reason: "inbox_full" })),
    ).toBeNull();
  });
  it("rejects unknown types, wrong versions and extra keys", () => {
    expect(decodeFrame(JSON.stringify({ v: 1, id, type: "nope" }))).toBeNull();
    expect(
      decodeFrame(
        JSON.stringify({
          v: 2,
          id,
          type: "hello",
          machine_label: "m",
          client_version: "0.1.0",
        }),
      ),
    ).toBeNull();
    expect(
      decodeFrame(
        JSON.stringify({
          v: 1,
          id,
          type: "hello",
          machine_label: "m",
          client_version: "0.1.0",
          x: 1,
        }),
      ),
    ).toBeNull();
  });
  it("rejects a body over the hard maximum and a bare ping", () => {
    const big = {
      v: 1,
      id,
      type: "send",
      from_ref: "s1",
      to_name: "a",
      body: "x".repeat(LIMITS.maxMessageBytes + 1),
    };
    expect(decodeFrame(JSON.stringify(big))).toBeNull();
    expect(decodeFrame("ping")).toBeNull();
  });
  it("refuses an inbound frame over the read cap without parsing it", () => {
    expect(decodeFrame("x".repeat(LIMITS.maxMessageBytes + 2048))).toBeNull();
  });
  it("names every frame the overview pins", () => {
    expect(CLIENT_FRAMES).toEqual([
      "hello",
      "agent_up",
      "agent_down",
      "sessions",
      "send",
      "ack",
      "refuse",
      "list",
      "fetch",
    ]);
    expect(SERVER_FRAMES).toEqual([
      "hello_ok",
      "agent_ok",
      "receipt",
      "roster",
      "body",
      "error",
      "deliver",
      "receipt_update",
      "roster_changed",
    ]);
  });
  it("formats a rejection with the frame id when there is one", () => {
    expect(formatFrameError("bad frame", null)).toBe("bad frame");
    expect(formatFrameError("bad frame", id)).toBe(`bad frame (frame ${id})`);
  });
});
