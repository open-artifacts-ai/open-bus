import { describe, expect, it } from "vitest";
import {
  AdapterFrame,
  AGENT_REF,
  DaemonFrame,
  MAX_LINE_BYTES,
} from "../src/frames.ts";

describe("local frame contract v1", () => {
  it("accepts a hello with no sender-supplied name field", () => {
    const frame = AdapterFrame.parse({
      v: 1,
      id: "1",
      type: "hello",
      kind: "claude-code",
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

describe("AGENT_REF", () => {
  it("caps at 128 characters like the shared contract", () => {
    expect(AGENT_REF.safeParse("a".repeat(128)).success).toBe(true);
    expect(AGENT_REF.safeParse("a".repeat(129)).success).toBe(false);
  });
});

describe("F2.4 shared contract", () => {
  it("REFUSAL is the shared list, ambiguous included", async () => {
    const { REFUSAL } = await import("../src/frames.ts");
    const { REFUSAL_REASONS } = await import("@ob/shared");
    expect(REFUSAL.options).toEqual([...REFUSAL_REASONS]);
    expect(REFUSAL.parse("ambiguous")).toBe("ambiguous");
  });

  it("a roster agent carries its state", () => {
    const f = DaemonFrame.parse({
      v: 1,
      id: "1",
      type: "roster",
      agents: [
        {
          name: "a",
          namespace: "ns",
          kind: "pi",
          live: false,
          state: "queued",
          global: false,
        },
      ],
    });
    expect(f).toMatchObject({ agents: [{ state: "queued", live: false }] });
  });

  it("daemon frames take an unknown kind token; hello does not", () => {
    const row = (kind: string) => ({
      name: "a",
      namespace: "ns",
      kind,
      live: true,
      state: "live",
      global: false,
    });
    expect(
      DaemonFrame.parse({
        v: 1,
        id: "1",
        type: "roster",
        agents: [row("pi"), row("zeta")],
      }),
    ).toMatchObject({ agents: [{ kind: "pi" }, { kind: "zeta" }] });
    expect(
      DaemonFrame.parse({ v: 1, id: "1", type: "agent", agent: row("zeta") }),
    ).toMatchObject({ agent: { kind: "zeta" } });
    expect(() =>
      DaemonFrame.parse({
        v: 1,
        id: "1",
        type: "roster",
        agents: [row("Not A Kind")],
      }),
    ).toThrow();
    expect(
      AdapterFrame.safeParse({
        v: 1,
        id: "1",
        type: "hello",
        kind: "zeta",
        agent_ref: "8a1f",
        pid: 1,
        cwd: "/repo",
      }).success,
    ).toBe(false);
  });

  it("send takes an optional target namespace", () => {
    const send = { v: 1, id: "1", type: "send", to: "peer", body: "hi" };
    expect(
      AdapterFrame.parse({ ...send, namespace: "github.com/acme/app" }),
    ).toMatchObject({ namespace: "github.com/acme/app" });
    expect(AdapterFrame.parse(send)).not.toHaveProperty("namespace");
    expect(() => AdapterFrame.parse({ ...send, namespace: "a\nb" })).toThrow();
  });
});

describe("adapter text must be well-formed unicode", () => {
  const send = (body: string) => ({
    v: 1,
    id: "1",
    type: "send",
    to: "peer",
    body,
  });
  it("a send body with a lone surrogate is rejected", () => {
    for (const body of ["a\ud800", "\udc00b", "x\udc00\ud800y"])
      expect(AdapterFrame.safeParse(send(body)).success, body).toBe(false);
    expect(AdapterFrame.safeParse(send("ok 😀")).success).toBe(true);
  });
  it("a hello's proposed_name with a lone surrogate is rejected", () => {
    const hello = (proposed_name: string) => ({
      v: 1,
      id: "h",
      type: "hello",
      kind: "pi",
      agent_ref: "s1",
      pid: 1,
      cwd: "/",
      proposed_name,
    });
    expect(AdapterFrame.safeParse(hello("p\ud800")).success).toBe(false);
    expect(AdapterFrame.safeParse(hello("p😀")).success).toBe(true);
  });
});
