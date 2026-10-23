import { existsSync } from "node:fs";
import { connect, createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { connectDaemon } from "../src/client.ts";
import { serveDaemon } from "../src/server.ts";
import { hello, ok, tmpSock, within } from "./helpers.ts";

describe("server hardening", () => {
  it("close() resolves while a client is still connected", async () => {
    const path = tmpSock();
    const s = await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => undefined,
    });
    const raw = connect(path);
    await new Promise((r) => raw.once("connect", r));
    const res = await within(s.close().then(() => "closed"));
    raw.destroy();
    expect(res).toBe("closed");
  });

  it("a second serveDaemon on a live socket refuses instead of unlinking it", async () => {
    const path = tmpSock();
    const first = await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => undefined,
    });
    const second = serveDaemon({ path, onHello: ok, onFrame: () => undefined });
    await expect(second).rejects.toThrow();
    // the first daemon must still be reachable
    const c = await connectDaemon({ path, hello: hello(), timeoutMs: 500 });
    c.close();
    void first;
  });

  it("an oversized send is refused too_large on its own id, not by killing the connection", async () => {
    const path = tmpSock();
    await serveDaemon({ path, onHello: ok, onFrame: () => undefined });
    const c = await connectDaemon({ path, hello: hello() });
    const r = await c
      .request({ type: "send", to: "p", body: "x".repeat(1024 * 1024 + 1) })
      .catch((e) => e);
    expect(r).toMatchObject({ id: "1" });
    expect(c.state).toBe("open");
  });
});

describe("server survives a throwing handler", () => {
  it("onHello throwing for one client answers that client with an error and keeps serving", async () => {
    const path = tmpSock();
    await serveDaemon({
      path,
      onHello: (h) => {
        if (h.agent_ref === "evil") throw new Error("pid gone");
        return ok();
      },
      onFrame: () => undefined,
    });
    await expect(
      connectDaemon({ path, hello: hello("evil"), timeoutMs: 500 }),
    ).rejects.toThrow(/pid gone|refused/);
    const good = await connectDaemon({
      path,
      hello: hello("good"),
      timeoutMs: 500,
    });
    expect(good.welcome.type).toBe("welcome");
    good.close();
  });
});

describe("server frame errors", () => {
  it("a handler throwing in onFrame answers internal on that id and keeps serving", async () => {
    const path = tmpSock();
    await serveDaemon({
      path,
      onHello: ok,
      onFrame: (f) => {
        if (f.type === "self") throw new Error("boom");
        return { type: "roster", agents: [] };
      },
    });
    const c = await connectDaemon({ path, hello: hello() });
    expect(await c.request({ type: "self", id: "x" })).toMatchObject({
      type: "error",
      code: "internal",
      id: "x",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.state).toBe("closed");
    const d = await connectDaemon({
      path,
      hello: hello("other"),
      timeoutMs: 500,
    });
    expect(await d.request({ type: "list" })).toMatchObject({ type: "roster" });
    d.close();
  });

  it("oversized send gets too_large on its id; connection stays open", async () => {
    const path = tmpSock();
    await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => ({ type: "receipt", msg_id: "m", state: "pending" }),
    });
    const c = await connectDaemon({ path, hello: hello() });
    const r = await c.request({
      type: "send",
      to: "p",
      body: "x".repeat(1024 * 1024 + 1),
      id: "big",
    });
    expect(r).toMatchObject({ type: "error", code: "too_large", id: "big" });
    expect(
      await c.request({ type: "send", to: "p", body: "ok" }),
    ).toMatchObject({ type: "receipt" });
    c.close();
  });

  it("other schema failures after hello answer bad_frame on the frame id and keep the connection (before hello they destroy)", async () => {
    const path = tmpSock();
    await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => ({ type: "roster", agents: [] }),
    });
    const c = await connectDaemon({ path, hello: hello() });
    const r = await c.request({ type: "send", id: "bad" }); // missing to/body
    expect(r).toMatchObject({ type: "error", code: "bad_frame", id: "bad" });
    expect(c.state).toBe("open");
    c.close();
  });

  it("async reply path: onFrame returns undefined, later reply() resolves the pending request", async () => {
    const path = tmpSock();
    await serveDaemon({
      path,
      onHello: ok,
      onFrame: (f, _h, reply) => {
        setTimeout(
          () => reply({ v: 1, id: f.id, type: "roster", agents: [] }),
          20,
        );
        return undefined;
      },
    });
    const c = await connectDaemon({ path, hello: hello() });
    expect(await c.request({ type: "list" })).toMatchObject({ type: "roster" });
    c.close();
  });

  it("serveDaemon close() unlinks only its own socket", async () => {
    const path = tmpSock();
    const first = await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => undefined,
    });
    await first.close();
    const second = await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => undefined,
    });
    await first.close();
    expect(existsSync(path)).toBe(true);
    await second.close();
    expect(existsSync(path)).toBe(false);
  });

  it("replaces a stale socket file left by a dead daemon", async () => {
    const path = tmpSock();
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(path, () => r()));
    // simulate a crash: stop accepting, but leave the socket file behind
    (dead as unknown as { _handle: { close(): void } })._handle.close();
    await new Promise((r) => setTimeout(r, 20));
    const s = await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => undefined,
    });
    await s.close();
  });
});
