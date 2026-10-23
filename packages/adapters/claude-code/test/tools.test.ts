import type { DaemonClient } from "@ob/ipc";
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
      content: [{ type: "text", text: "Delivery pending." }],
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
    expect(r.content[0].text).toMatch(/unknown_agent/);
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
            global: false,
          },
        ],
      })),
    );
    expect(r.content[0].text).toBe("- alpha (pi, ns)");
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
