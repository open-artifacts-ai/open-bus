import { describe, expect, it } from "vitest";
import { AdapterFrame, DaemonFrame, MAX_LINE_BYTES } from "../src/frames.ts";

describe("local frame contract v1", () => {
  it("accepts a hello with no sender-supplied name field", () => {
    const frame = AdapterFrame.parse({
      v: 1,
      id: "1",
      type: "hello",
      kind: "claude",
      agent_ref: "8a1f",
      pid: 4321,
      cwd: "/repo",
      attest: { session_id: "8a1f", socket_path: "/tmp/cc-socks/4321.sock" },
    });
    expect(frame.type).toBe("hello");
    expect("from" in frame).toBe(false);
  });

  it("strips a sender-supplied from on send", () => {
    const bad = {
      v: 1,
      id: "2",
      type: "send",
      from: "someone-else",
      to: "peer",
      body: "hi",
    };
    expect(AdapterFrame.parse(bad)).not.toHaveProperty("from");
  });

  it("rejects an oversized body at the schema", () => {
    expect(() =>
      AdapterFrame.parse({
        v: 1,
        id: "3",
        type: "send",
        to: "peer",
        body: "x".repeat(1024 * 1024 + 1),
      }),
    ).toThrow();
  });

  it("caps the body in UTF-8 bytes, not characters", () => {
    // 400k chars x 3 bytes = 1.2 MB: under the char count, over the byte cap
    const body = "€".repeat(400_000);
    expect(body.length).toBeLessThan(1024 * 1024);
    expect(() =>
      AdapterFrame.parse({ v: 1, id: "4", type: "send", to: "peer", body }),
    ).toThrow();
    expect(
      AdapterFrame.parse({
        v: 1,
        id: "5",
        type: "send",
        to: "peer",
        body: "€".repeat(300_000),
      }).type,
    ).toBe("send");
  });

  it("rejects an empty body", () => {
    expect(() =>
      AdapterFrame.parse({ v: 1, id: "6", type: "send", to: "peer", body: "" }),
    ).toThrow();
  });

  it("caps a line above the body cap", () => {
    expect(MAX_LINE_BYTES).toBe(4 * 1024 * 1024);
  });

  it("accepts a deliver with a notice instead of a body", () => {
    const f = DaemonFrame.parse({
      v: 1,
      id: "9",
      type: "deliver",
      msg_id: "m1",
      from_name: "peer",
      namespace: "github.com/acme/app",
      notice: { size: 40000, msg_id: "m1" },
    });
    expect(f.type).toBe("deliver");
  });

  it("a deliver must carry exactly one of body or notice", () => {
    const base = {
      v: 1,
      id: "0",
      type: "deliver",
      msg_id: "m",
      from_name: "p",
      namespace: "n",
    };
    expect(() => DaemonFrame.parse(base)).toThrow();
    expect(() =>
      DaemonFrame.parse({
        ...base,
        body: "x",
        notice: { size: 1, msg_id: "m" },
      }),
    ).toThrow();
    expect(DaemonFrame.parse({ ...base, body: "x" }).type).toBe("deliver");
  });
});
