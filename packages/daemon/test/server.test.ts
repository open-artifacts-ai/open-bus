import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attest } from "../src/attest.ts";
import type { DeliverOutcome } from "../src/deliver.ts";
import { daemonHarness, deliverFrame, stopAll } from "./helpers.ts";

const realTmp = () => realpathSync(mkdtempSync(join(tmpdir(), "ob-srv-")));

afterEach(stopAll);

describe("runDaemon local server", () => {
  it("attests, resolves the namespace and announces agent_up", async () => {
    const resolveNamespace = vi.fn(() => ({
      namespace: "github.com/acme/app",
      global: true,
      source: "git" as const,
    }));
    const h = await daemonHarness({ resolveNamespace });
    const a = await h.adapter("A", {
      cwd: "/work/app",
      proposed_name: "alpha",
    });
    expect(resolveNamespace).toHaveBeenCalledWith("/work/app");
    expect(a.welcome).toMatchObject({
      agent_ref: "A",
      bus_name: "alpha",
      namespace: "github.com/acme/app",
      global: true,
    });
    expect(await h.next("agent_up")).toMatchObject({
      agent_ref: "A",
      kind: "claude-code",
      proposed_name: "alpha",
      namespace: "github.com/acme/app",
      global: true,
    });
  });

  it("refuses a hello that fails attestation", async () => {
    const h = await daemonHarness({
      attest: () => ({
        ok: false,
        reason: "no Claude session in the ancestry",
      }),
    });
    await expect(h.adapter("A")).rejects.toThrow(/no Claude session/);
    expect(h.of("agent_up")).toEqual([]);
  });

  it("takes from_ref from the hello, never from a frame field", async () => {
    const h = await daemonHarness();
    const a = await h.adapter("A");
    const reply = a.request({
      type: "send",
      to: "b",
      body: "hi",
      from_ref: "B",
    } as Parameters<typeof a.request>[0]);
    const sent = await h.next("send");
    expect(sent).toMatchObject({ from_ref: "A", to_name: "b", body: "hi" });
    h.toDaemon({
      id: sent.id,
      type: "receipt",
      msg_id: "m1",
      state: "pending",
    });
    expect(await reply).toMatchObject({ type: "receipt", msg_id: "m1" });
  });

  it("remaps hub ids so two adapters never see each other's replies", async () => {
    const h = await daemonHarness();
    const a = await h.adapter("A");
    const b = await h.adapter("B");
    const ra = a.request({ type: "list", id: "1" });
    const rb = b.request({ type: "list", id: "1" });
    await h.next("list", 2);
    const lists = h.of("list");
    const byRef = Object.fromEntries(lists.map((l) => [l.from_ref, l.id]));
    expect(byRef.A).not.toBe("1");
    expect(byRef.A).not.toBe(byRef.B);
    const roster = (name: string) => [
      { name, namespace: "ns", kind: "claude-code", live: true, global: false },
    ];
    // Answer in reverse order.
    h.toDaemon({ id: byRef.B, type: "roster", agents: roster("for-b") });
    h.toDaemon({ id: byRef.A, type: "roster", agents: roster("for-a") });
    expect(await ra).toMatchObject({ id: "1", agents: [{ name: "for-a" }] });
    expect(await rb).toMatchObject({ id: "1", agents: [{ name: "for-b" }] });
  });

  it("forwards fetch with the attested ref", async () => {
    const h = await daemonHarness();
    const a = await h.adapter("A");
    const r = a.request({ type: "fetch", msg_id: "m9" });
    const f = await h.next("fetch");
    expect(f).toMatchObject({ from_ref: "A", msg_id: "m9" });
    h.toDaemon({ id: f.id, type: "body", msg_id: "m9", body: "long" });
    expect(await r).toMatchObject({ type: "body", body: "long" });
  });

  it("answers self from the agent table, with the hub's bus name", async () => {
    const h = await daemonHarness();
    const a = await h.adapter("A");
    const up = await h.next("agent_up");
    h.toDaemon({
      id: up.id,
      type: "agent_ok",
      agent_ref: "A",
      bus_name: "amber",
    });
    await vi.waitFor(async () =>
      expect(await a.request({ type: "self" })).toMatchObject({
        type: "agent",
        agent: {
          name: "amber",
          namespace: "ns",
          kind: "claude-code",
          live: true,
        },
      }),
    );
  });

  it("fails a request at once when the hub is down", async () => {
    const h = await daemonHarness({ hub: { backoffMs: () => 60_000 } });
    const a = await h.adapter("A");
    h.hubSock()?.terminate();
    await vi.waitFor(() => expect(h.daemon.hub.open).toBe(false));
    expect(await a.request({ type: "list" })).toMatchObject({
      type: "error",
      code: "hub_unavailable",
    });
  });

  it("times out a request the hub never answers", async () => {
    const h = await daemonHarness({ pendingTimeoutMs: 50 });
    const a = await h.adapter("A");
    expect(await a.request({ type: "list", id: "7" })).toMatchObject({
      id: "7",
      type: "error",
      code: "timeout",
    });
  });

  it("fails pending requests when the hub drops", async () => {
    const h = await daemonHarness({ hub: { backoffMs: () => 60_000 } });
    const a = await h.adapter("A");
    const r = a.request({ type: "list", id: "7" });
    await h.next("list");
    h.hubSock()?.terminate();
    expect(await r).toMatchObject({
      id: "7",
      type: "error",
      code: "hub_unavailable",
    });
  });

  it("re-announces live agents after a reconnect", async () => {
    const h = await daemonHarness();
    await h.adapter("A");
    await h.next("agent_up");
    h.hubSock()?.terminate();
    expect(await h.next("agent_up", 2)).toMatchObject({ agent_ref: "A" });
    expect(h.of("sessions").at(-1)).toMatchObject({ open: ["A"], closed: [] });
  });

  it("marks an agent closed when its last connection goes", async () => {
    const h = await daemonHarness();
    const a1 = await h.adapter("A");
    const a2 = await h.adapter("A");
    const before = h.of("sessions").length;
    a1.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.of("sessions").length).toBe(before);
    a2.close();
    expect(await h.next("sessions", before + 1)).toMatchObject({
      open: [],
      closed: ["A"],
    });
  });

  it("ignores a local ack for a message not in flight to that agent", async () => {
    const h = await daemonHarness();
    const a = await h.adapter("A");
    a.ack("m1");
    // A later request on the same connection still answers in order.
    expect(await a.request({ type: "self" })).toMatchObject({ type: "agent" });
    expect(h.of("ack")).toEqual([]);
  });

  it("an adapter ack wins over the transport's later outcome", async () => {
    let finish!: (o: DeliverOutcome) => void;
    const transport = vi.fn(
      (..._a: unknown[]) =>
        new Promise<DeliverOutcome>((r) => {
          finish = r;
        }),
    );
    const h = await daemonHarness({ transports: { pi: transport } });
    const p = await h.adapter("A", { kind: "pi" });
    h.toDaemon(deliverFrame("m1"));
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    p.ack("m1");
    expect(await h.next("ack")).toMatchObject({ msg_id: "m1" });
    finish({ ok: false, reason: "closed", cause: "expired" });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.of("refuse")).toEqual([]);
    expect(h.daemon.agents.byRef("A")?.live).toBe(true);
    h.toDaemon(deliverFrame("m1"));
    await h.next("ack", 2);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("refuses a hello for a live agent_ref from another kind or pid", async () => {
    const h = await daemonHarness();
    await h.adapter("A", { kind: "claude-code" });
    await expect(h.adapter("A", { kind: "pi" })).rejects.toThrow(
      /agent_ref is in use by another session/,
    );
    await expect(h.adapter("A", { pid: 1 })).rejects.toThrow(
      /agent_ref is in use by another session/,
    );
    expect(h.daemon.agents.byRef("A")).toMatchObject({
      kind: "claude-code",
      pid: process.pid,
    });
  });

  it("reuses a live record for the same kind and pid, never re-homing it", async () => {
    const h = await daemonHarness({
      resolveNamespace: (cwd) => ({
        namespace: cwd.slice(1),
        global: false,
        source: "cwd",
      }),
    });
    await h.adapter("A", { cwd: "/team-a" });
    const up = await h.next("agent_up");
    h.toDaemon({
      id: up.id,
      type: "agent_ok",
      agent_ref: "A",
      bus_name: "amber",
    });
    await vi.waitFor(() =>
      expect(h.daemon.agents.byRef("A")?.busName).toBe("amber"),
    );
    const again = await h.adapter("A", { cwd: "/team-b" });
    expect(again.welcome).toMatchObject({
      bus_name: "amber",
      namespace: "team-a",
    });
    expect(h.daemon.agents.byRef("A")?.namespace).toBe("team-a");
  });

  it("resolves a Claude namespace from the session file's cwd", async () => {
    const dir = realTmp();
    const project = realTmp();
    writeFileSync(
      join(dir, `${process.pid}.json`),
      JSON.stringify({ sessionId: "S", procStart: "x", cwd: project }),
    );
    const resolveNs = vi.fn((_cwd: string) => ({
      namespace: "ns",
      global: false,
      source: "cwd" as const,
    }));
    const h = await daemonHarness({
      attest: (hl) =>
        attest(hl, {
          sessionsDir: dir,
          ancestors: () => [process.pid],
          procStart: () => "x",
        }),
      resolveNamespace: resolveNs,
    });
    await h.adapter("S", { cwd: "/someone/elses/project" });
    expect(resolveNs).toHaveBeenCalledWith(project);
  });

  it("accepts a live Claude session whose start directory moved", async () => {
    const dir = realTmp();
    const gone = join(realTmp(), "moved-away");
    writeFileSync(
      join(dir, `${process.pid}.json`),
      JSON.stringify({ sessionId: "S", procStart: "x", cwd: gone }),
    );
    const h = await daemonHarness({
      resolveNamespace: undefined,
      attest: (hl) =>
        attest(hl, {
          sessionsDir: dir,
          ancestors: () => [process.pid],
          procStart: () => "x",
        }),
    });
    const s = await h.adapter("S");
    expect(s.welcome).toMatchObject({ namespace: "moved-away" });
  });

  it("refuses a relative or unresolvable cwd", async () => {
    const h = await daemonHarness({ resolveNamespace: undefined });
    await expect(h.adapter("A", { kind: "pi", cwd: "." })).rejects.toThrow(
      /cwd must be absolute/,
    );
    await expect(
      h.adapter("B", { cwd: join(realTmp(), "gone") }),
    ).rejects.toThrow(/cwd/);
    expect(h.of("agent_up")).toEqual([]);
  });

  it("refuses a delivery to an unknown, closed or transportless agent", async () => {
    const transport = vi.fn(async () => ({ ok: true }) as const);
    const h = await daemonHarness({ transports: { pi: transport } });
    const a = await h.adapter("A"); // claude-code: no transport
    await h.adapter("P", { kind: "pi" }).then((p) => p.close());
    await h.next("sessions", 2);
    h.toDaemon(deliverFrame("m1", "nobody"));
    h.toDaemon(deliverFrame("m2", "A"));
    h.toDaemon(deliverFrame("m3", "P"));
    await h.next("refuse", 3);
    expect(h.of("refuse").map((r) => [r.msg_id, r.reason, r.detail])).toEqual([
      ["m1", "closed", "dropped"],
      ["m2", "closed", "dropped"],
      ["m3", "closed", "dropped"],
    ]);
    expect(transport).not.toHaveBeenCalled();
    expect(h.of("ack")).toEqual([]);
    a.close();
  });
});
