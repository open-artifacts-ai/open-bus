import { describe, expect, it } from "vitest";
import { LIMITS } from "./limits.js";
import {
  CLIENT_FRAMES,
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
  formatFrameError,
  SERVER_FRAMES,
} from "./protocol.js";

const id = "7Yb3kQmZ1xRt9PvA";
const mid = "aaaaaaaaaaaaaaaa";
const okc = (raw: string) => {
  const r = decodeClientFrame(raw);
  return r.ok ? r.frame : null;
};
const oks = (raw: string) => {
  const r = decodeServerFrame(raw);
  return r.ok ? r.frame : null;
};

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
    expect(okc(encodeFrame(send))).toEqual(send);
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
    expect(oks(encodeFrame(deliver))).toEqual(deliver);
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
    expect(oks(encodeFrame(f))).toEqual(f);
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
    expect(okc(encodeFrame(f))).toEqual(f);
    expect(okc(JSON.stringify({ ...f, detail: "held" }))).toBeNull();
    expect(okc(JSON.stringify({ ...f, reason: "inbox_full" }))).toBeNull();
  });
  it("rejects unknown types, wrong versions and extra keys", () => {
    expect(okc(JSON.stringify({ v: 1, id, type: "nope" }))).toBeNull();
    expect(
      okc(
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
      okc(
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
    expect(decodeClientFrame(JSON.stringify(big))).toEqual({
      ok: false,
      error: "too_large",
      id,
    });
    expect(okc("ping")).toBeNull();
  });
  it("refuses an inbound frame over the read cap without parsing it", () => {
    expect(
      decodeClientFrame("x".repeat(2 * LIMITS.maxMessageBytes + 4097)),
    ).toEqual({ ok: false, error: "too_large" });
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

  it("is direction-safe", () => {
    const deliver = {
      v: 1,
      id,
      type: "deliver",
      msg_id: mid,
      to_ref: "s1",
      from_name: "Pi",
      namespace: "n",
      body: "hi",
    };
    const send = {
      v: 1,
      id,
      type: "send",
      from_ref: "s1",
      to_name: "a",
      body: "hi",
    };
    expect(decodeClientFrame(JSON.stringify(deliver))).toEqual({
      ok: false,
      error: "bad_frame",
      id,
    });
    expect(decodeServerFrame(JSON.stringify(send))).toEqual({
      ok: false,
      error: "bad_frame",
      id,
    });
    expect(
      decodeClientFrame(
        JSON.stringify({
          v: 1,
          id,
          type: "receipt",
          msg_id: mid,
          state: "delivered",
        }),
      ).ok,
    ).toBe(false);
  });
  it("never throws on non-strings", () => {
    for (const x of [null, undefined, 1, {}, new ArrayBuffer(4)]) {
      expect(decodeClientFrame(x as never)).toEqual({
        ok: false,
        error: "bad_frame",
      });
      expect(decodeServerFrame(x as never)).toEqual({
        ok: false,
        error: "bad_frame",
      });
    }
  });
  it("encodes v then id first, so an oversize id can be recovered", () => {
    const s = encodeFrame({ type: "ack", msg_id: mid, id, v: 1 } as never);
    expect(s.startsWith(`{"v":1,"id":"${id}"`)).toBe(true);
    const huge = `{"v":1,"id":"${id}","type":"send","body":"${"x".repeat(2 * LIMITS.maxMessageBytes)}"}`;
    expect(decodeClientFrame(huge)).toEqual({
      ok: false,
      error: "too_large",
      id,
    });
  });
  it("round-trips escape-heavy legal bodies", () => {
    for (const body of [
      '"'.repeat(600_000),
      "\n".repeat(500_000),
      "\0".repeat(170_000),
      '{"a":"b"}'.repeat(100_000),
    ]) {
      const f = {
        v: 1,
        id,
        type: "send",
        from_ref: "s1",
        to_name: "a",
        body,
      } as const;
      expect(okc(encodeFrame(f))).toEqual(f);
    }
  });
  it("pre-scan rejects deep nesting and token floods", () => {
    const deep = `{"v":1,"id":"${id}","type":"ack","msg_id":"${mid}","x":${"[".repeat(5000)}${"]".repeat(5000)}}`;
    expect(decodeClientFrame(deep)).toEqual({ ok: false, error: "bad_frame" });
    const keys = Array.from({ length: 5000 }, (_, i) => `"k${i}":1`).join(",");
    expect(
      decodeClientFrame(`{"v":1,"id":"${id}","type":"ack",${keys}}`).ok,
    ).toBe(false);
    // colons and brackets inside strings are ignored, escapes respected
    const f = {
      v: 1,
      id,
      type: "send",
      from_ref: "s1",
      to_name: "a",
      body: `[[[[[[:,:,"\\${":,".repeat(5000)}`,
    } as const;
    expect(okc(encodeFrame(f))).toEqual(f);
  });
  it("worst adversarial inputs decode fast", () => {
    const cap = 2 * LIMITS.maxMessageBytes;
    const inputs = [
      `{"v":1,"id":"${id}","x":${"[".repeat(cap / 2)}`,
      `{"v":1,"id":"${id}","type":"hello",${Array.from({ length: 90000 }, (_, i) => `"k${i}":1`).join(",")}}`,
      `{"v":1,"id":"${id}","type":"roster","agents":[${"{},".repeat(350000)}{}]}`,
      `{"v":1,"id":"${id}","type":"ack"${" ".repeat(cap)}}`,
      `{"v":1,"id":"${id}","type":"send","body":"${'\\"'.repeat(cap / 4)}"}`,
    ];
    for (const raw of inputs) {
      decodeClientFrame(raw);
      const times: number[] = [];
      for (let i = 0; i < 15; i++) {
        const t0 = performance.now();
        decodeClientFrame(raw);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      // median: robust to GC pauses from the multi-MB inputs
      expect(times[7]).toBeLessThan(5);
    }
  });
  it("bounds strings, refs, sessions and deliver", () => {
    const base = { v: 1, id } as const;
    const hello = {
      ...base,
      type: "hello",
      machine_label: "m",
      client_version: "0.1.0",
    };
    expect(
      okc(JSON.stringify({ ...hello, machine_label: "a".repeat(129) })),
    ).toBeNull();
    expect(
      okc(JSON.stringify({ ...hello, machine_label: "a\u202eb" })),
    ).toBeNull();
    expect(okc(JSON.stringify({ ...hello, machine_label: "a\nb" }))).toBeNull();
    expect(
      okc(JSON.stringify({ ...hello, client_version: "1".repeat(65) })),
    ).toBeNull();
    expect(
      oks(
        JSON.stringify({
          ...base,
          type: "error",
          code: "internal",
          message: "x".repeat(1025),
        }),
      ),
    ).toBeNull();
    expect(
      oks(
        JSON.stringify({
          ...base,
          type: "hello_ok",
          machine_id: "a".repeat(16),
          machine_label: "x".repeat(1025),
          server_version: "1",
        }),
      ),
    ).toBeNull();
    for (const ref of ["__proto__", "constructor", "prototype", "a b", "é"]) {
      expect(
        okc(JSON.stringify({ ...base, type: "agent_down", agent_ref: ref })),
      ).toBeNull();
    }
    expect(
      okc(
        JSON.stringify({
          ...base,
          type: "agent_down",
          agent_ref: "ses_a.b:c-d",
        }),
      ),
    ).not.toBeNull();
    const s = (open: string[], closed: string[]) =>
      okc(JSON.stringify({ ...base, type: "sessions", open, closed }));
    expect(s(["a", "b"], ["c"])).not.toBeNull();
    expect(s(["a", "a"], [])).toBeNull();
    expect(s([], ["a", "a"])).toBeNull();
    expect(s(["a"], ["a"])).toBeNull();
    const dv = {
      ...base,
      type: "deliver",
      msg_id: mid,
      to_ref: "s1",
      from_name: "Pi",
      namespace: "n",
    };
    expect(
      oks(JSON.stringify({ ...dv, body: "x".repeat(LIMITS.inlineBodyBytes) })),
    ).not.toBeNull();
    expect(
      oks(
        JSON.stringify({ ...dv, body: "x".repeat(LIMITS.inlineBodyBytes + 1) }),
      ),
    ).toBeNull();
    const n = (size: number, m = mid) =>
      oks(JSON.stringify({ ...dv, notice: { size, msg_id: m } }));
    expect(n(LIMITS.inlineBodyBytes + 1)).not.toBeNull();
    expect(n(LIMITS.maxMessageBytes)).not.toBeNull();
    expect(n(LIMITS.inlineBodyBytes)).toBeNull();
    expect(n(LIMITS.maxMessageBytes + 1)).toBeNull();
    expect(n(40000, "bbbbbbbbbbbbbbbb")).toBeNull();
  });
  it("applies receipt rules on the wire", () => {
    const r = (type: string, state: string, reason?: string) =>
      JSON.stringify({
        v: 1,
        id,
        type,
        msg_id: mid,
        state,
        ...(reason ? { reason } : {}),
      });
    expect(oks(r("receipt", "pending"))).not.toBeNull();
    expect(oks(r("receipt", "refused", "inbox_full"))).not.toBeNull();
    expect(oks(r("receipt", "delivered"))).toBeNull();
    expect(oks(r("receipt", "refused"))).toBeNull();
    expect(oks(r("receipt", "pending", "closed"))).toBeNull();
    expect(oks(r("receipt_update", "delivered"))).not.toBeNull();
    expect(
      oks(r("receipt_update", "expired", "recipient_closed")),
    ).not.toBeNull();
    expect(oks(r("receipt_update", "delivered", "inbox_full"))).toBeNull();
    expect(oks(r("receipt_update", "refused", "recipient_closed"))).toBeNull();
    expect(oks(r("receipt_update", "expired", "too_large"))).toBeNull();
  });
});
