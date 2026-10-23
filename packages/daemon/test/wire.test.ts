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
