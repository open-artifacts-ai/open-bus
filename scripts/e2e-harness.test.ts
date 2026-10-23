// Self-test for the staging scenario harness (e2e/staging/harness.ts). It needs
// no hub: an in-process fake hub speaks the F2 wire frames, so `pnpm test`
// proves the harness itself before the real hub exists.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeHub, fakeHub } from "../e2e/staging/fake-hub.ts";
import {
  cookieHeader,
  eventually,
  liveHub,
  type Machine,
  type MachineOptions,
  machine,
  probeUpgrade,
  restSession,
  tmpDir,
  workspace,
} from "../e2e/staging/harness.ts";

let hub: FakeHub | undefined;
const machines: Machine[] = [];

afterEach(async () => {
  await Promise.all(machines.splice(0).map((m) => m.dispose()));
  await hub?.close();
  hub = undefined;
});

async function setup(): Promise<FakeHub> {
  hub = await fakeHub();
  return hub;
}

async function mk(label: string): Promise<Machine> {
  const h = hub ?? (await setup());
  const opts: MachineOptions = {
    hub: h.url,
    rest: restSession(h.url, h.cookie),
    pollMs: 5,
  };
  const m = await machine(label, opts);
  machines.push(m);
  return m;
}

describe("e2e harness against a fake hub", () => {
  it("logs two machines in through the device flow, each with its own OPENBUS_HOME", async () => {
    const a = await mk("alpha");
    const b = await mk("beta");
    expect(a.home).not.toBe(b.home);
    for (const m of [a, b]) {
      const file = join(m.home, "machine.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
        hub: hub?.url,
        label: m.label,
        machine_id: m.machineId,
      });
    }
    expect(a.machineId).not.toBe(b.machineId);
    // Two machines to the hub: two tokens, two sockets.
    await eventually(() =>
      expect(hub?.connected().sort()).toEqual(
        [a.machineId, b.machineId].sort(),
      ),
    );
    expect(new Set(hub?.tokens()).size).toBe(2);
  });

  it("connects fake sessions to each daemon's own local socket", async () => {
    const a = await mk("alpha");
    const b = await mk("beta");
    const ns = workspace("e2e-self");
    const sa = await a.session("claude-code", "claude-ref-1", ns, {
      name: "cc",
    });
    const sb = await b.session("opencode", "ses_one", ns, { name: "oc" });
    expect(sa.socketPath).toBe(join(a.home, "daemon.sock"));
    expect(sb.socketPath).toBe(join(b.home, "daemon.sock"));
    expect(statSync(sa.socketPath).isSocket()).toBe(true);
    await eventually(() =>
      expect(hub?.agents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            machine_id: a.machineId,
            agent_ref: "claude-ref-1",
            namespace: "e2e-self",
          }),
          expect.objectContaining({
            machine_id: b.machineId,
            agent_ref: "ses_one",
            kind: "opencode",
          }),
        ]),
      ),
    );
    expect(await sa.name()).toBe("cc");
  });

  it("routes a message each way; the reply goes back to the sender's bus name", async () => {
    const a = await mk("alpha");
    const b = await mk("beta");
    const ns = workspace("e2e-route");
    const sa = await a.session("claude-code", "claude-ref-1", ns, {
      name: "cc",
    });
    const sb = await b.session("opencode", "ses_one", ns, { name: "oc" });
    await eventually(async () =>
      expect((await sa.roster()).map((x) => x.name)).toContain("oc"),
    );
    const r = await sa.send("oc", "ping");
    expect(r.state).toBe("pending");
    const got = await eventually(() => {
      const [m] = sb.inbox();
      expect(m).toBeDefined();
      return m as NonNullable<typeof m>;
    });
    expect(got).toMatchObject({ body: "ping", from_name: "cc" });
    await eventually(() => expect(a.receipts(r.msg_id)).toContain("delivered"));
    await sb.send(got.from_name, "pong");
    await eventually(() =>
      expect(sa.inbox().map((m) => m.body)).toEqual(["pong"]),
    );
    expect(sa.inbox()[0]?.from_name).toBe("oc");
  });

  it("reports the hub's bus name as soon as a session is open", async () => {
    const b = await mk("beta");
    const dir = workspace("e2e-twins");
    const one = await b.session("opencode", "ses_one", dir, { name: "oc" });
    const two = await b.session("opencode", "ses_two", dir, { name: "oc" });
    expect([await one.name(), await two.name()]).toEqual(["oc", "oc-2"]);
  });

  it("refuses a session the daemon cannot attest", async () => {
    const a = await mk("alpha");
    await expect(
      a.session("opencode", "ses_ghost", workspace("e2e-x"), {
        attested: false,
      }),
    ).rejects.toThrow(/not open in a TUI|attest/);
  });

  it("a closed TUI is refused and nothing is injected", async () => {
    const a = await mk("alpha");
    const b = await mk("beta");
    const ns = workspace("e2e-close");
    const sa = await a.session("claude-code", "claude-ref-1", ns, {
      name: "cc",
    });
    const sb = await b.session("opencode", "ses_one", ns, { name: "oc" });
    await eventually(async () =>
      expect((await sa.roster()).map((x) => x.name)).toContain("oc"),
    );
    await sb.closeTui();
    const r = await eventually(async () => {
      const x = await sa.send("oc", "hello?");
      expect(x).toMatchObject({ state: "refused", reason: "closed" });
      return x;
    });
    expect(r.state).toBe("refused");
    expect(sb.inbox()).toEqual([]);
  });

  it("takes a machine offline and back without losing its sessions", async () => {
    const a = await mk("alpha");
    const sa = await a.session(
      "claude-code",
      "claude-ref-1",
      workspace("e2e-off"),
      { name: "cc" },
    );
    await a.offline();
    await eventually(() => expect(hub?.connected()).toEqual([]));
    await a.online();
    await eventually(() => expect(hub?.connected()).toEqual([a.machineId]));
    await eventually(async () =>
      expect((await sa.roster()).map((x) => x.name)).toContain("cc"),
    );
  });

  it("sees a revoke: close code 4403, the daemon stops and the token is refused", async () => {
    const a = await mk("alpha");
    await eventually(() => expect(hub?.connected()).toEqual([a.machineId]));
    await a.revoke();
    await eventually(() => expect(a.closeCodes()).toContain(4403));
    await eventually(() => expect(a.revoked()).toBe(true));
    expect(process.exitCode ?? 0).toBe(0);
    expect(await probeUpgrade(a.hub, a.token())).toBe(401);
  });

  it("restarts a daemon on the same OPENBUS_HOME and its sessions re-hello", async () => {
    const a = await mk("alpha");
    const sa = await a.session(
      "claude-code",
      "claude-ref-1",
      workspace("e2e-rs"),
      { name: "cc" },
    );
    await a.stop();
    await a.start();
    await eventually(() => expect(hub?.connected()).toEqual([a.machineId]));
    await eventually(async () => expect(await sa.name()).toBe("cc"));
  });
});

describe("liveHub gate", () => {
  it("skips when E2E_HUB is unset", async () => {
    expect(await liveHub({})).toEqual({
      ok: false,
      reason: expect.stringMatching(/E2E_HUB is not set/),
    });
  });

  it("skips while GET /hub is 404", async () => {
    const srv = createServer((_q, s) => s.writeHead(404).end());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    try {
      expect(await liveHub({ E2E_HUB: `http://127.0.0.1:${port}` })).toEqual({
        ok: false,
        reason: expect.stringMatching(/404/),
      });
    } finally {
      srv.close();
    }
  });

  it("skips when the hub is unreachable", async () => {
    expect(await liveHub({ E2E_HUB: "http://127.0.0.1:1" })).toMatchObject({
      ok: false,
    });
  });

  it("runs once the upgrade route exists", async () => {
    const h = await setup();
    expect(await liveHub({ E2E_HUB: h.url })).toEqual({ ok: true, hub: h.url });
  });
});

describe("cookieHeader", () => {
  it("picks the hub's unexpired cookies from a Playwright storage state", () => {
    const file = join(tmpDir("state"), "state.json");
    const future = Date.now() / 1000 + 3600;
    writeFileSync(
      file,
      JSON.stringify({
        cookies: [
          {
            name: "CF_Authorization",
            value: "a",
            domain: ".open-bus.ai",
            path: "/",
            expires: future,
          },
          {
            name: "ob_session",
            value: "b",
            domain: "staging.open-bus.ai",
            path: "/",
            expires: -1,
          },
          {
            name: "old",
            value: "c",
            domain: "staging.open-bus.ai",
            path: "/",
            expires: 1,
          },
          {
            name: "other",
            value: "d",
            domain: "example.com",
            path: "/",
            expires: -1,
          },
          {
            name: "deep",
            value: "e",
            domain: "staging.open-bus.ai",
            path: "/admin",
            expires: -1,
          },
        ],
        origins: [],
      }),
    );
    expect(cookieHeader(file, "https://staging.open-bus.ai")).toBe(
      "CF_Authorization=a; ob_session=b",
    );
  });
});
