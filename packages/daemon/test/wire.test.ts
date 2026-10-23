import { describe, expect, it } from "vitest";
import { decodeServerFrame } from "../src/wire.ts";

const j = (o: unknown) => JSON.stringify(o);

describe("decodeServerFrame", () => {
  it("accepts hub->daemon frames", () => {
    const r = decodeServerFrame(
      j({
        v: 1,
        id: "1",
        type: "deliver",
        msg_id: "m",
        to_ref: "r",
        from_name: "a",
        namespace: "n",
        body: "hi",
      }),
    );
    expect(r).toMatchObject({ ok: true, frame: { type: "deliver" } });
    expect(
      decodeServerFrame(
        j({
          v: 1,
          id: "1",
          type: "receipt_update",
          msg_id: "m",
          state: "delivered",
        }),
      ).ok,
    ).toBe(true);
  });

  it("rejects a daemon->hub frame type", () => {
    const r = decodeServerFrame(
      j({
        v: 1,
        id: "1",
        type: "hello",
        machine_label: "x",
        client_version: "1",
      }),
    );
    expect(r).toMatchObject({ ok: false, error: "bad_frame", id: "1" });
  });

  it("never throws on garbage", () => {
    expect(decodeServerFrame("{")).toMatchObject({
      ok: false,
      error: "bad_frame",
    });
    expect(decodeServerFrame("null")).toMatchObject({
      ok: false,
      error: "bad_frame",
    });
  });

  it("rejects an oversized inline deliver", () => {
    const r = decodeServerFrame(
      j({
        v: 1,
        id: "1",
        type: "deliver",
        msg_id: "m",
        to_ref: "r",
        from_name: "a",
        namespace: "n",
        body: "é".repeat(16 * 1024 + 1),
      }),
    );
    expect(r).toMatchObject({ ok: false, error: "too_large" });
  });

  it("requires notice.msg_id to equal msg_id", () => {
    const base = {
      v: 1,
      id: "1",
      type: "deliver",
      msg_id: "m",
      to_ref: "r",
      from_name: "a",
      namespace: "n",
    };
    expect(
      decodeServerFrame(j({ ...base, notice: { size: 99999, msg_id: "m" } }))
        .ok,
    ).toBe(true);
    expect(
      decodeServerFrame(j({ ...base, notice: { size: 99999, msg_id: "z" } }))
        .ok,
    ).toBe(false);
  });
});

describe("hardened decodeServerFrame", () => {
  const d = (o: object) =>
    decodeServerFrame(JSON.stringify({ v: 1, id: "x", ...o }));
  it("rejects a notice with a negative or fractional size", () => {
    const base = {
      type: "deliver",
      msg_id: "m",
      to_ref: "a",
      from_name: "f",
      namespace: "n",
    };
    expect(d({ ...base, notice: { size: -1, msg_id: "m" } }).ok).toBe(false);
    expect(d({ ...base, notice: { size: 1.5, msg_id: "m" } }).ok).toBe(false);
  });
  it("rejects a notice whose size fits inline", () => {
    const base = {
      type: "deliver",
      msg_id: "m",
      to_ref: "a",
      from_name: "f",
      namespace: "n",
    };
    expect(d({ ...base, notice: { size: 10, msg_id: "m" } }).ok).toBe(false);
  });
  it("rejects an empty bus_name in agent_ok", () => {
    expect(d({ type: "agent_ok", agent_ref: "a", bus_name: "" }).ok).toBe(
      false,
    );
  });
  it("does not let __proto__ keys through", () => {
    const r = decodeServerFrame(
      '{"v":1,"id":"x","type":"roster_changed","namespace":"n","__proto__":{"polluted":1}}',
    );
    expect(r.ok).toBe(true);
    if (r.ok)
      expect((r.frame as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("too_large boundary: exactly 32 KiB of multibyte UTF-8 passes, one more byte fails", () => {
    const base = {
      type: "deliver",
      msg_id: "m",
      to_ref: "a",
      from_name: "f",
      namespace: "n",
    };
    expect(d({ ...base, body: "é".repeat(16384) }).ok).toBe(true);
    expect(d({ ...base, body: `${"é".repeat(16384)}a` })).toMatchObject({
      ok: false,
      error: "too_large",
    });
  });
});
