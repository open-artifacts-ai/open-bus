// AC5b: set_status and card in the shared MCP tools (Claude Code, OpenCode, Codex).
import {
  CARD_COPY,
  type DaemonClient,
  type DaemonFrame,
  daemonOffersCard,
  earlierStatusText,
  statusSetText,
} from "@ob/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, type Gate, TOOLS } from "../src/tools.ts";

/** AGENT_CARD_MIN_CLIENT, pinned: the gate is this release. */
const GATE = "0.55.0";
const JWS = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
const NONCE = "n0nce-n0nce-n0nce";
const AUD = "https://artifacts.example.com";

type Frame = { type: string } & Record<string, unknown>;

/** A daemon whose `self` reports `version`; `answer` replies to everything else. */
function daemon(
  version: string | undefined,
  answer: (f: Frame) => Record<string, unknown>,
) {
  const frames: Frame[] = [];
  const request = vi.fn(async (f: Frame) => {
    frames.push(f);
    const out =
      f.type === "self"
        ? {
            type: "agent",
            agent: {
              name: "me",
              namespace: "ns",
              kind: "claude",
              live: true,
              global: false,
            },
            ...(version ? { daemon_version: version } : {}),
          }
        : answer(f);
    return { v: 1, id: "1", ...out } as DaemonFrame;
  });
  return { frames, client: { request } as unknown as DaemonClient };
}

const ok = (f: Frame) =>
  f.type === "set_status" ? { type: "status_set" } : { type: "card", jwt: JWS };

const call = (
  name: string,
  args: Record<string, unknown>,
  d: ReturnType<typeof daemon>,
  gate?: Gate,
) => callTool(name, args, d.client, undefined, gate);

describe("set_status and card: shapes", () => {
  it("adds both tools after the four, vendor-neutral", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "list_agents",
      "send_message",
      "fetch",
      "self",
      "set_status",
      "card",
    ]);
    for (const t of TOOLS) expect(t.description).not.toMatch(/claude/i);
  });

  it("set_status: one of four states and an optional label of at most 64", () => {
    const t = TOOLS.find((x) => x.name === "set_status");
    expect(t?.inputSchema).toEqual({
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["working", "idle", "blocked", "waiting_on_owner"],
        },
        label: {
          type: "string",
          maxLength: 64,
          description: "What you are on, in a few words.",
        },
      },
      required: ["state"],
      additionalProperties: false,
    });
    expect(t?.description).toMatch(/user sees it labelled as your own report/);
  });

  it("card: audience and nonce, only for an app the user linked", () => {
    const t = TOOLS.find((x) => x.name === "card");
    expect(t?.inputSchema).toMatchObject({
      properties: {
        audience: { type: "string" },
        nonce: { type: "string" },
      },
      required: ["audience", "nonce"],
      additionalProperties: false,
    });
    expect(t?.description).toMatch(/only for that/);
    expect(t?.description).toMatch(/Open Artifacts/);
    expect(t?.description).toMatch(/present_card/);
  });
});

describe("set_status and card: the daemon version gate (self)", () => {
  it("pins the gate", () => {
    expect(daemonOffersCard(GATE)).toBe(true);
    expect(daemonOffersCard("0.54.9")).toBe(false);
    expect(daemonOffersCard(undefined)).toBe(false);
  });

  it.each([
    ["set_status", { state: "working" }],
    ["card", { audience: AUD, nonce: NONCE }],
  ])("%s at the gate goes to the daemon after self", async (name, args) => {
    const d = daemon(GATE, ok);
    const r = await call(name, args, d);
    expect(r.isError).toBe(false);
    expect(d.frames.map((f) => f.type)).toEqual(["self", name]);
  });

  it.each([
    ["set_status", { state: "working" }, "0.54.0"],
    ["card", { audience: AUD, nonce: NONCE }, "0.54.0"],
    ["set_status", { state: "working" }, undefined],
    ["card", { audience: AUD, nonce: NONCE }, undefined],
    ["card", { audience: AUD, nonce: NONCE }, "0.55.0-rc.1"],
  ])(
    "%s below the gate (%s, daemon %s) refuses with AC5a's unsupported copy and sends nothing",
    async (name, args, version) => {
      const d = daemon(version, ok);
      expect(await call(name, args, d)).toEqual({
        content: [{ type: "text", text: CARD_COPY.unsupported }],
        isError: true,
      });
      expect(d.frames.map((f) => f.type)).toEqual(["self"]);
    },
  );
});

describe("set_status", () => {
  it("sends the state and label, opted in to late notices, and says what the user sees", async () => {
    const d = daemon(GATE, ok);
    const r = await call(
      "set_status",
      { state: "working", label: "writing tests", from: "spoofed" },
      d,
    );
    expect(d.frames[1]).toEqual({
      type: "set_status",
      state: "working",
      label: "writing tests",
      late: true,
    });
    expect(r).toEqual({
      content: [
        { type: "text", text: statusSetText("working", "writing tests") },
      ],
      isError: false,
    });
    // DRAFT copy, pinned until Design rules.
    expect(r.content[0]?.text).toBe(
      'Your status is now working: "writing tests". The user sees it as your own report.',
    );
  });

  it("an empty label is no label", async () => {
    const d = daemon(GATE, ok);
    const r = await call("set_status", { state: "idle", label: "" }, d);
    expect(d.frames[1]).toEqual({
      type: "set_status",
      state: "idle",
      late: true,
    });
    expect(r.content[0]?.text).toBe(
      "Your status is now idle. The user sees it as your own report.",
    );
  });

  it("shows an earlier refusal after this call's result", async () => {
    const d = daemon(GATE, () => ({
      type: "status_set",
      earlier: { code: "not_registered", message: CARD_COPY.not_registered },
    }));
    const r = await call("set_status", { state: "blocked" }, d);
    expect(r.isError).toBe(false);
    expect(r.content[0]?.text).toBe(
      `${statusSetText("blocked")}\n\n${earlierStatusText(CARD_COPY.not_registered)}`,
    );
    expect(earlierStatusText("X")).toBe(
      "Your previous status did not reach the user. X",
    );
  });

  it.each(["rate_limited", "not_registered", "bad_frame", "unsupported"])(
    "a %s refusal is the daemon's copy, as-is",
    async (code) => {
      const message = CARD_COPY[code as keyof typeof CARD_COPY];
      const d = daemon(GATE, () => ({ type: "error", code, message }));
      expect(await call("set_status", { state: "idle" }, d)).toEqual({
        content: [{ type: "text", text: message }],
        isError: true,
      });
    },
  );

  it.each([
    [{ state: "sleeping" }, /^openbus: state: /],
    [{ state: "idle", label: "x".repeat(65) }, /^openbus: label: /],
    [{}, /^openbus: state: /],
  ])("refuses bad arguments before the daemon: %j", async (args, msg) => {
    const d = daemon(GATE, ok);
    const r = await call("set_status", args, d);
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(msg);
    expect(d.frames).toEqual([]);
  });

  it("a 64-character label passes", async () => {
    const d = daemon(GATE, ok);
    const r = await call(
      "set_status",
      { state: "idle", label: "é".repeat(64) },
      d,
    );
    expect(r.isError).toBe(false);
  });
});

describe("card", () => {
  it("sends audience as aud with the nonce, and returns the JWS alone", async () => {
    const d = daemon(GATE, ok);
    const r = await call("card", { audience: AUD, nonce: NONCE }, d);
    expect(d.frames[1]).toEqual({
      type: "card",
      aud: AUD,
      nonce: NONCE,
      late: true,
    });
    expect(r).toEqual({
      content: [{ type: "text", text: JWS }],
      isError: false,
    });
  });

  it.each(Object.keys(CARD_COPY))(
    "a %s refusal is the daemon's copy, as-is",
    async (code) => {
      const message = CARD_COPY[code as keyof typeof CARD_COPY];
      const d = daemon(GATE, () => ({ type: "error", code, message }));
      expect(await call("card", { audience: AUD, nonce: NONCE }, d)).toEqual({
        content: [{ type: "text", text: message }],
        isError: true,
      });
    },
  );

  it("a nonce that cannot be one is bad_nonce, before the daemon", async () => {
    const d = daemon(GATE, ok);
    expect(await call("card", { audience: AUD, nonce: "short" }, d)).toEqual({
      content: [{ type: "text", text: CARD_COPY.bad_nonce }],
      isError: true,
    });
    expect(d.frames).toEqual([]);
  });

  it.each(["http://artifacts.example.com", "https://a.example.com/path", ""])(
    "an audience that is not an exact https origin is refused before the daemon: %j",
    async (audience) => {
      const d = daemon(GATE, ok);
      const r = await call("card", { audience, nonce: NONCE }, d);
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text).toMatch(/^openbus: aud: /);
      expect(d.frames).toEqual([]);
    },
  );

  it("a daemon that is down is a tool error, not a throw", async () => {
    const request = vi.fn(async () => {
      throw new Error("the daemon connection closed");
    });
    const r = await callTool("card", { audience: AUD, nonce: NONCE }, {
      request,
    } as unknown as DaemonClient);
    expect(r).toEqual({
      content: [
        { type: "text", text: "openbus: the daemon connection closed" },
      ],
      isError: true,
    });
  });
});

describe("the reply gate (one-request connections: Codex)", () => {
  it.each([
    ["set_status", { state: "working" }],
    ["card", { audience: AUD, nonce: NONCE }],
  ])("%s sends one request, no self", async (name, args) => {
    const d = daemon(GATE, ok);
    const r = await call(name, args, d, "reply");
    expect(r.isError).toBe(false);
    expect(d.frames.map((f) => f.type)).toEqual([name]);
  });

  it("an older daemon's bad_frame for the unknown type is the unsupported copy", async () => {
    const d = daemon(undefined, () => ({
      type: "error",
      code: "bad_frame",
      message: "Invalid input",
    }));
    for (const [name, args] of [
      ["set_status", { state: "working" }],
      ["card", { audience: AUD, nonce: NONCE }],
    ] as const)
      expect(await call(name, args, d, "reply")).toEqual({
        content: [{ type: "text", text: CARD_COPY.unsupported }],
        isError: true,
      });
  });

  it("the hub's bad_frame (AC5a's copy) stays as-is", async () => {
    const d = daemon(GATE, () => ({
      type: "error",
      code: "bad_frame",
      message: CARD_COPY.bad_frame,
    }));
    expect(
      (await call("card", { audience: AUD, nonce: NONCE }, d, "reply"))
        .content[0]?.text,
    ).toBe(CARD_COPY.bad_frame);
  });
});

describe("the card's JWS is never logged", () => {
  afterEach(() => vi.restoreAllMocks());

  it("nothing the adapter writes to the console or stderr holds it", async () => {
    const written: string[] = [];
    const keep = (...a: unknown[]) => {
      written.push(a.map(String).join(" "));
    };
    for (const m of ["log", "error", "warn", "info", "debug"] as const)
      vi.spyOn(console, m).mockImplementation(keep);
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      keep(c);
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      keep(c);
      return true;
    });
    for (const gate of ["self", "reply"] as const) {
      const r = await call(
        "card",
        { audience: AUD, nonce: NONCE },
        daemon(GATE, ok),
        gate,
      );
      expect(r.content[0]?.text).toBe(JWS);
    }
    const parts = JWS.split(".");
    for (const w of written) for (const p of parts) expect(w).not.toContain(p);
  });
});
