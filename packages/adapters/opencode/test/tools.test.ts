import { CLIENT_VERSION, type DaemonClient, type Hello } from "@ob/ipc";
import { describe, expect, it, vi } from "vitest";
import type { OpenCodeSession } from "../src/session.ts";
import { handleToolCall, nameOf, SESSION_META, TOOLS } from "../src/tools.ts";

const receipt = async (f: { id?: string }) => ({
  v: 1 as const,
  id: f.id ?? "1",
  type: "receipt" as const,
  msg_id: "mmmmmmmmmmmmmmm1",
  state: "pending" as const,
});

/** One shared service: every session's calls land in the same process. */
function service(roots: Record<string, OpenCodeSession>) {
  const hellos: Hello[] = [];
  const requests: { ref: string; frame: unknown }[] = [];
  const closed: string[] = [];
  const connect = vi.fn(async (hello: Hello) => {
    hellos.push(hello);
    return {
      request: vi.fn(async (f: { id?: string }) => {
        requests.push({ ref: hello.agent_ref, frame: f });
        return receipt(f);
      }),
      close: () => closed.push(hello.agent_ref),
    } as unknown as DaemonClient;
  });
  const resolve = vi.fn(async (id: string) => roots[id] ?? null);
  return { hellos, requests, closed, connect, resolve };
}

const call = (
  svc: ReturnType<typeof service>,
  sessionID: string | undefined,
  name = "send_message",
  args: Record<string, unknown> = { to: "peer", text: "hi" },
) =>
  handleToolCall({
    name,
    args,
    meta: sessionID === undefined ? undefined : { [SESSION_META]: sessionID },
    connect: svc.connect,
    resolve: svc.resolve,
  });

describe("opencode mcp tools", () => {
  it("exposes the four vendor-neutral tools", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "list_agents",
      "send_message",
      "fetch",
      "self",
    ]);
  });

  it("gives two sessions in one service their own identity and directory", async () => {
    const svc = service({
      ses_a: { root: "ses_a", directory: "/work/a", title: null },
      ses_b: { root: "ses_b", directory: "/work/b", title: null },
    });
    await call(svc, "ses_a");
    await call(svc, "ses_b");
    expect(svc.hellos.map((h) => [h.agent_ref, h.cwd, h.kind])).toEqual([
      ["ses_a", "/work/a", "opencode"],
      ["ses_b", "/work/b", "opencode"],
    ]);
    expect(svc.requests.map((r) => r.ref)).toEqual(["ses_a", "ses_b"]);
    // Each call's connection is its own, and is closed after it.
    expect(svc.closed).toEqual(["ses_a", "ses_b"]);
  });

  it("says hello with the IPC marker (C23c)", async () => {
    const svc = service({
      ses_a: { root: "ses_a", directory: "/work/a", title: null },
    });
    await call(svc, "ses_a");
    expect(svc.hellos[0]?.client_version).toBe(CLIENT_VERSION);
  });

  it("names the hello cwd from the session, never the service's cwd", async () => {
    const svc = service({
      ses_a: { root: "ses_a", directory: "/work/a", title: null },
    });
    await call(svc, "ses_a");
    expect(svc.hellos[0]?.cwd).toBe("/work/a");
    expect(svc.hellos[0]?.cwd).not.toBe(process.cwd());
  });

  it("maps a child session to its root", async () => {
    const svc = service({
      ses_child: { root: "ses_root", directory: "/work/app", title: null },
    });
    await call(svc, "ses_child");
    expect(svc.resolve).toHaveBeenCalledWith("ses_child");
    expect(svc.hellos[0]).toMatchObject({
      agent_ref: "ses_root",
      attest: { session_id: "ses_child" },
    });
  });

  it("takes identity from _meta, never from the tool arguments", async () => {
    const svc = service({
      ses_a: { root: "ses_a", directory: "/work/a", title: null },
    });
    const r = await call(svc, "ses_a", "send_message", {
      to: "peer",
      text: "hi",
      from: "ses_b",
      from_ref: "ses_b",
      sessionID: "ses_b",
    });
    expect(r.content[0]?.text).toBe(
      "○  Queued for peer. Not delivered yet; expires in 1 hour.",
    );
    expect(svc.resolve).toHaveBeenCalledOnce();
    expect(svc.resolve).toHaveBeenCalledWith("ses_a");
    expect(svc.requests[0]?.frame).toEqual({
      type: "send",
      to: "peer",
      body: "hi",
      late: true,
    });
    expect(JSON.stringify(svc.hellos)).not.toContain("ses_b");
  });

  it("refuses a call without a session id, or one it cannot place", async () => {
    const svc = service({
      ses_rel: { root: "ses_rel", directory: null, title: null },
    });
    for (const id of [undefined, "", "ses_unknown", "ses_rel"]) {
      const r = await call(svc, id);
      expect(r.isError).toBe(true);
    }
    expect(svc.connect).not.toHaveBeenCalled();
    const bad = await handleToolCall({
      name: "self",
      args: {},
      meta: { [SESSION_META]: 42 },
      connect: svc.connect,
      resolve: svc.resolve,
    });
    expect(bad.isError).toBe(true);
  });

  it("proposes a bus name slugged from the root session's title", async () => {
    const svc = service({
      ses_a: { root: "ses_a", directory: "/w", title: "Fix login bug!" },
      ses_b: { root: "ses_b", directory: "/w", title: "   " },
      ses_c: { root: "ses_c", directory: "/w", title: null },
    });
    await call(svc, "ses_a");
    await call(svc, "ses_b");
    await call(svc, "ses_c");
    expect(svc.hellos.map((h) => h.proposed_name)).toEqual([
      "fix-login-bug",
      "opencode",
      "opencode",
    ]);
  });

  it("slugs any title into a valid bus name", () => {
    expect(nameOf("Refactor: the API / v2")).toBe("refactor-the-api-v2");
    expect(nameOf("OpenBus")).toBe("opencode"); // reserved
    expect(nameOf("10.0.0.1")).toBe("10-0-0-1");
    expect(nameOf("ünïcode ✓ only")).toBe("n-code-only");
    expect(nameOf("x".repeat(100))).toHaveLength(64);
    expect(nameOf("New session - 2026-10-23T10:11:12.000Z")).toBe("opencode");
  });

  it("never throws out of a handler", async () => {
    const out = await handleToolCall({
      name: "list_agents",
      args: {},
      meta: { [SESSION_META]: "ses_1" },
      connect: async () => {
        throw new Error("daemon down");
      },
      resolve: async () => ({ root: "ses_1", directory: "/w", title: null }),
    });
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain("daemon down");
    const thrown = await handleToolCall({
      name: "list_agents",
      args: {},
      meta: { [SESSION_META]: "ses_1" },
      connect: vi.fn(),
      resolve: async () => {
        throw new Error("api exploded");
      },
    });
    expect(thrown.isError).toBe(true);
  });
});

describe("a cancelled OpenCode tool call (C17)", () => {
  it("closes its daemon connection when the call is cancelled", async () => {
    const svc = service({
      ses_a: { root: "ses_a", directory: "/work/a", title: null },
    });
    const ac = new AbortController();
    ac.abort();
    await handleToolCall({
      name: "self",
      args: {},
      meta: { [SESSION_META]: "ses_a" },
      connect: svc.connect,
      resolve: svc.resolve,
      signal: ac.signal,
    });
    // Nothing was asked of the daemon; the connection is closed (twice is harmless).
    expect(svc.requests).toEqual([]);
    expect(new Set(svc.closed)).toEqual(new Set(["ses_a"]));
  });
});
