import { type DaemonClient, excerptOf, receiptText } from "@ob/ipc";
import { describe, expect, it, vi } from "vitest";
import { callTool, TOOLS } from "../src/tools.ts";

const client = (request: DaemonClient["request"]) =>
  ({ request }) as unknown as DaemonClient;

describe("claude mcp tools", () => {
  it("exposes the four vendor-neutral tools", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "list_agents",
      "send_message",
      "fetch",
      "self",
    ]);
    for (const t of TOOLS) expect(t.description).not.toMatch(/claude/i);
  });

  it("never takes the sender from tool arguments", async () => {
    const request = vi.fn(async (f: { id?: string }) => ({
      v: 1 as const,
      id: f.id ?? "1",
      type: "receipt" as const,
      msg_id: "mmmmmmmmmmmmmmm1",
      state: "pending" as const,
    }));
    const r = await callTool(
      "send_message",
      { to: "peer", text: "hi", from: "spoofed", from_ref: "B" },
      client(request),
    );
    expect(request).toHaveBeenCalledWith({
      type: "send",
      to: "peer",
      body: "hi",
    });
    expect(r).toEqual({
      content: [
        {
          type: "text",
          text: "○  Queued for peer. Not delivered yet; expires in 1 hour.",
        },
      ],
      isError: false,
    });
  });

  it("reports a refusal with its reason", async () => {
    const r = await callTool(
      "send_message",
      { to: "peer", text: "hi" },
      client(async () => ({
        v: 1,
        id: "1",
        type: "receipt",
        msg_id: "mmmmmmmmmmmmmmm1",
        state: "refused",
        reason: "unknown_agent",
      })),
    );
    expect(r).toMatchObject({ isError: true });
    // The transcript's layout, from the one renderer, so it cannot drift.
    expect(r.content[0].text).toBe(
      receiptText(
        { state: "refused", reason: "unknown_agent" },
        "peer",
        undefined,
        excerptOf("hi"),
      ),
    );
    expect(r.content[0].text).toBe(
      '×  Refused (unknown_agent): your message to peer, "hi",\n   was not delivered.\n   No agent has that name here.\n   Run list_agents to see who is in this namespace.',
    );
  });

  it("forwards to_namespace as the target namespace", async () => {
    const request = vi.fn(async () => ({
      v: 1 as const,
      id: "1",
      type: "receipt" as const,
      msg_id: "mmmmmmmmmmmmmmm1",
      state: "pending" as const,
    }));
    await callTool(
      "send_message",
      { to: "peer", text: "hi", to_namespace: "github.com/acme/app" },
      client(request),
    );
    expect(request).toHaveBeenCalledWith({
      type: "send",
      to: "peer",
      body: "hi",
      namespace: "github.com/acme/app",
    });
    const send = TOOLS.find((t) => t.name === "send_message");
    expect(send?.inputSchema.properties).toHaveProperty("to_namespace");
  });

  it("names how many namespaces hold an ambiguous name", async () => {
    const roster = (name: string, namespace: string) => ({
      name,
      namespace,
      kind: "pi" as const,
      live: true,
      state: "live" as const,
      global: false,
    });
    const request = vi.fn(async (f: { type: string }) =>
      f.type === "send"
        ? {
            v: 1 as const,
            id: "1",
            type: "receipt" as const,
            msg_id: "mmmmmmmmmmmmmmm1",
            state: "refused" as const,
            reason: "ambiguous" as const,
          }
        : {
            v: 1 as const,
            id: "2",
            type: "roster" as const,
            agents: [
              roster("docs-writer", "a"),
              roster("docs-writer", "b"),
              roster("other", "c"),
            ],
          },
    );
    const r = await callTool(
      "send_message",
      { to: "docs-writer", text: "hi" },
      client(request as unknown as DaemonClient["request"]),
    );
    expect(r).toEqual({
      content: [
        {
          type: "text",
          text: receiptText(
            { state: "refused", reason: "ambiguous" },
            "docs-writer",
            2,
            excerptOf("hi"),
          ),
        },
      ],
      isError: true,
    });
  });

  it("lists the roster", async () => {
    const r = await callTool(
      "list_agents",
      {},
      client(async () => ({
        v: 1,
        id: "1",
        type: "roster",
        agents: [
          {
            name: "alpha",
            kind: "pi",
            namespace: "ns",
            live: true,
            state: "live",
            global: false,
          },
          {
            name: "beta",
            kind: "claude-code",
            namespace: "ns",
            live: false,
            state: "queued",
            global: false,
          },
        ],
      })),
    );
    expect(r.content[0].text).toBe(
      "- alpha (pi, ns)\n- beta (claude-code, ns) (queued)",
    );
  });

  it("returns isError instead of throwing when the daemon is down", async () => {
    const r = await callTool(
      "list_agents",
      {},
      client(async () => {
        throw new Error("daemon connection closed");
      }),
    );
    expect(r).toEqual({
      content: [{ type: "text", text: "openbus: daemon connection closed" }],
      isError: true,
    });
  });

  it("answers an unknown tool or a daemon error as isError", async () => {
    const err = client(async () => ({
      v: 1,
      id: "1",
      type: "error",
      code: "hub_unavailable",
      message: "the hub is not connected",
    }));
    expect(await callTool("nope", {}, err)).toMatchObject({ isError: true });
    const r = await callTool("fetch", { msg_id: "mmmmmmmmmmmmmmm1" }, err);
    expect(r).toMatchObject({ isError: true });
    expect(r.content[0].text).toMatch(/the hub is not connected/);
  });
});
