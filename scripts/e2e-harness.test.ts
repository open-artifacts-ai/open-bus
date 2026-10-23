// Self-test for the staging scenario harness (e2e/staging/harness.ts). It needs
// no hub: an in-process fake hub speaks the F2 wire frames, so `pnpm test`
// proves the harness itself before the real hub exists.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { join } from "node:path";
import { isRunning, liveClaudeSessions, procStartOf } from "@ob/daemon";
import { ClientFrameSchema, frameId, namespaceFrom, newId } from "@ob/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { type FakeHub, fakeHub } from "../e2e/staging/fake-hub.ts";
import {
  assertNoOuterConfig,
  assertSeedHub,
  cookieHeader,
  envMachineOptions,
  eventually,
  gitRepo,
  liveHub,
  type Machine,
  type MachineOptions,
  machine,
  probeUpgrade,
  type RestSession,
  restSession,
  seedMode,
  sleep,
  tmpDir,
  workspace,
} from "../e2e/staging/harness.ts";

let hub: FakeHub | undefined;
const machines: Machine[] = [];
const servers: Server[] = [];

afterEach(async () => {
  const spawned = machines.flatMap((m) => m.spawned());
  await Promise.all(machines.splice(0).map((m) => m.dispose()));
  for (const s of servers.splice(0)) s.close();
  await hub?.close();
  hub = undefined;
  // The daemon never runs a real `opencode` on the machine running the tests;
  // checked after cleanup, so a failure never leaves machines unrevoked.
  expect(spawned).toEqual([]);
});

async function setup(): Promise<FakeHub> {
  hub = await fakeHub();
  return hub;
}

async function mk(
  label: string,
  rest?: (h: FakeHub) => RestSession,
): Promise<Machine> {
  const h = hub ?? (await setup());
  const opts: MachineOptions = {
    hub: h.url,
    rest: rest?.(h) ?? restSession(h.url, h.cookie),
    pollMs: 5,
  };
  const m = await machine(label, opts);
  machines.push(m);
  return m;
}

/** Two machines with a Claude session on a and an OpenCode session on b, in one namespace. */
async function pair(ns = "e2e-pair") {
  const a = await mk("alpha");
  const b = await mk("beta");
  const sa = await a.session("claude-code", "claude-ref-1", workspace(ns), {
    name: "cc",
  });
  const sb = await b.session("opencode", "ses_one", workspace(ns), {
    name: "oc",
  });
  return { a, b, sa, sb };
}

async function server(handler: RequestListener): Promise<string> {
  const srv = createServer(handler);
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
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

  it("fails login at once when the approval is rejected", async () => {
    await setup();
    const started = Date.now();
    await expect(
      mk("alpha", (h) => restSession(h.url, "ob_session=wrong")),
    ).rejects.toThrow(/approval failed: .*403/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("connects fake sessions to each daemon's own local socket", async () => {
    const { a, b, sa, sb } = await pair("e2e-self");
    expect(sa.socketPath).toBe(join(a.home, "daemon.sock"));
    expect(sb.socketPath).toBe(join(b.home, "daemon.sock"));
    expect(statSync(sa.socketPath).isSocket()).toBe(true);
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
    );
  });

  it("reports the hub's bus name as soon as a session is open", async () => {
    const b = await mk("beta");
    const dir = workspace("e2e-twins");
    const one = await b.session("opencode", "ses_one", dir, { name: "oc" });
    const two = await b.session("opencode", "ses_two", dir, { name: "oc" });
    expect([await one.name(), await two.name()]).toEqual(["oc", "oc-2"]);
  });

  it("resolves a namespace from git: ssh and https remotes are one namespace", async () => {
    const a = await mk("alpha");
    const ssh = gitRepo("git@github.com:acme/widget.git");
    const https = gitRepo("https://github.com/acme/widget");
    const s1 = await a.session("claude-code", "claude-g1", ssh);
    const s2 = await a.session("opencode", "ses_g2", https);
    const expected = namespaceFrom({
      remoteUrl: "https://github.com/acme/widget",
      gitRootName: "repo",
      cwd: https,
    });
    expect((await s1.info()).namespace).toBe(expected);
    expect((await s2.info()).namespace).toBe(expected);
  });

  it("routes a message each way; the reply goes back to the sender's bus name", async () => {
    const { a, sa, sb } = await pair("e2e-route");
    const r = await sa.send("oc", "ping");
    expect(r.state).toBe("pending");
    // The hub's raw reply is matched to this send by frame id.
    expect(sa.hubReply("send", (q) => q.body === "ping")).toMatchObject({
      type: "receipt",
      msg_id: r.msg_id,
      state: "pending",
    });
    const got = await eventually(() => {
      const [m] = sb.inbox();
      expect(m).toBeDefined();
      return m as NonNullable<typeof m>;
    });
    expect(got).toMatchObject({ body: "ping", from_name: "cc" });
    await eventually(() => expect(a.receipts(r.msg_id)).toEqual(["delivered"]));
    await sb.send(got.from_name, "pong");
    await eventually(() =>
      expect(sa.inbox().map((m) => m.body)).toEqual(["pong"]),
    );
    expect(sa.inbox()[0]?.from_name).toBe("oc");
  });

  it("records every transport call for a session", async () => {
    const { sa, sb } = await pair("e2e-calls");
    await sa.send("oc", "one");
    await sa.send("oc", "two");
    await eventually(() =>
      expect(sb.inbox().map((m) => m.body)).toEqual(["one", "two"]),
    );
    expect(sa.inbox()).toEqual([]);
  });

  it("closeTui removes presence but keeps the adapter connected", async () => {
    const { sb } = await pair("e2e-tui");
    await sb.closeTui();
    expect(await sb.name()).toBe("oc");
  });

  // OpenCode liveness is presence, which the daemon watches only from C6; a
  // Claude session closes when its session file goes (C5), so these use one.
  it("a closed session is refused and the transport is never called", async () => {
    const { b, sa } = await pair("e2e-close");
    const cb = await b.session(
      "claude-code",
      "claude-ref-2",
      workspace("e2e-close"),
      {
        name: "cb",
      },
    );
    await cb.close();
    await eventually(() => expect(b.live(cb.ref)).toBe(false));
    expect(await sa.send("cb", "hello?")).toMatchObject({
      state: "refused",
      reason: "closed",
    });
    await sleep(200);
    expect(cb.inbox()).toEqual([]);
  });

  it("never announces the user's own Claude sessions", async () => {
    // A decoy that is live by the daemon's real liveness: this process's pid
    // and its real start time, under HOME and under the sessions-dir override.
    const decoyHome = tmpDir("home");
    const homeDir = join(decoyHome, ".claude", "sessions");
    const envDir = tmpDir("cs");
    mkdirSync(homeDir, { recursive: true });
    const decoy = JSON.stringify({
      pid: process.pid,
      sessionId: "decoy-ref",
      procStart: procStartOf(process.pid),
      cwd: decoyHome,
      name: "decoy",
    });
    for (const d of [homeDir, envDir])
      writeFileSync(join(d, `${process.pid}.json`), decoy);
    const live = (dir: string) =>
      liveClaudeSessions({ dir, procStart: procStartOf, isRunning });
    expect(live(homeDir).map((x) => x.ref)).toEqual(["decoy-ref"]);
    const prev = {
      HOME: process.env.HOME,
      OPENBUS_CLAUDE_SESSIONS_DIR: process.env.OPENBUS_CLAUDE_SESSIONS_DIR,
    };
    try {
      process.env.HOME = decoyHome;
      for (const dir of [undefined, envDir]) {
        if (dir) process.env.OPENBUS_CLAUDE_SESSIONS_DIR = dir;
        else delete process.env.OPENBUS_CLAUDE_SESSIONS_DIR;
        await mk(dir ? "env" : "home");
        await sleep(600); // three Claude sync ticks
        expect(hub?.agents().map((a) => a.agent_ref)).not.toContain(
          "decoy-ref",
        );
      }
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("refuses to run under a .openbus.json above the temp dir", () => {
    const base = tmpDir("outer");
    writeFileSync(join(base, ".openbus.json"), '{"namespace":"leak"}');
    const inner = join(base, "t");
    mkdirSync(inner);
    expect(() => assertNoOuterConfig(inner)).toThrow(
      /would apply to every e2e namespace/,
    );
    expect(() => assertNoOuterConfig()).not.toThrow();
  });

  it("resolves namespaces with no user git config", async () => {
    const cfg = join(tmpDir("gitcfg"), "gitconfig");
    writeFileSync(
      cfg,
      '[url "https://rewritten.example/"]\n\tinsteadOf = https://github.com/\n',
    );
    const prev = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = cfg;
    try {
      const a = await mk("alpha");
      const s1 = await a.session(
        "opencode",
        "ses_cfg",
        gitRepo("https://github.com/acme/widget"),
      );
      expect((await s1.info()).namespace).toMatch(/^github\.com\//);
    } finally {
      if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prev;
    }
  });

  it("a global sender's name held in two namespaces is refused as ambiguous", async () => {
    const a = await mk("alpha");
    await a.session("opencode", "ses_x", workspace("e2e-amb-x"), {
      name: "twin",
    });
    await a.session("opencode", "ses_y", workspace("e2e-amb-y"), {
      name: "twin",
    });
    const g = await a.session(
      "opencode",
      "ses_g",
      workspace("e2e-amb-g", { global: true }),
      { name: "glob" },
    );
    expect(await g.send("twin", "which?")).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
  });

  it("refuses a session the daemon cannot attest", async () => {
    const a = await mk("alpha");
    await expect(
      a.session("opencode", "ses_ghost", workspace("e2e-x"), {
        attested: false,
      }),
    ).rejects.toThrow(/not open in a TUI|attest/);
  });

  it("queues mail while offline, injects nothing, and delivers on reconnect", async () => {
    const { b, sa, sb } = await pair("e2e-off");
    await b.offline();
    await eventually(async () =>
      expect(await sa.hubRoster()).toEqual([
        expect.objectContaining({ bus_name: "cc", state: "live" }),
        expect.objectContaining({ bus_name: "oc", state: "queued" }),
      ]),
    );
    expect((await sa.send("oc", "later")).state).toBe("pending");
    await sleep(200);
    expect(sb.inbox()).toEqual([]);
    await b.online();
    await eventually(() =>
      expect(sb.inbox().map((m) => m.body)).toEqual(["later"]),
    );
  });

  it("a crashed Claude session (file left behind) is refused, nothing injected", async () => {
    const { b, sa } = await pair("e2e-crash");
    const cb = await b.session(
      "claude-code",
      "claude-ref-2",
      workspace("e2e-crash"),
      {
        name: "cb",
      },
    );
    await cb.crash();
    await eventually(() => expect(b.live(cb.ref)).toBe(false));
    expect(await sa.send("cb", "hello?")).toMatchObject({
      state: "refused",
      reason: "closed",
    });
    await sleep(200);
    expect(cb.inbox()).toEqual([]);
  });

  it("a reused pid (start time moved, file left behind) is refused, nothing injected", async () => {
    const { b, sa } = await pair("e2e-reuse");
    const cb = await b.session(
      "claude-code",
      "claude-ref-2",
      workspace("e2e-reuse"),
      {
        name: "cb",
      },
    );
    await sleep(600); // the daemon has checked this pid's start time
    // The pid is free for a few sync ticks, then a new process takes it.
    await cb.reusePid(600);
    await eventually(() => expect(b.live(cb.ref)).toBe(false));
    expect(await sa.send("cb", "hello?")).toMatchObject({
      state: "refused",
      reason: "closed",
    });
    await sleep(200);
    expect(cb.inbox()).toEqual([]);
  });

  // Client finding (C5 liveness/claude.ts cachedProcStart), fixed in C6: a
  // cached start time lives at most one sync interval, so a pid reused
  // between two sync ticks is re-checked. The first test runs it and must
  // stay healthy; the second holds the expectation the fix makes true.
  let fastReuse: { liveAfter: boolean | undefined } | undefined;
  it("a pid reused between two sync ticks: the daemon stays healthy", async () => {
    const { b } = await pair("e2e-reuse-fast");
    const cb = await b.session(
      "claude-code",
      "claude-ref-3",
      workspace("e2e-reuse-fast"),
      {
        name: "cb",
      },
    );
    await sleep(600);
    expect(b.live(cb.ref)).toBe(true);
    await cb.reusePid(0);
    await sleep(1_000); // five sync ticks
    fastReuse = { liveAfter: b.live(cb.ref) };
    expect(await cb.name()).toBe("cb");
  });
  it("a pid reused between two sync ticks is seen as closed", () => {
    expect(fastReuse).toBeDefined();
    expect(fastReuse?.liveAfter).toBe(false);
  });

  it("expires mail for a session closed while offline; reopening gets none of it", async () => {
    const { a, b, sa } = await pair("e2e-offclose");
    const cb = await b.session(
      "claude-code",
      "claude-ref-2",
      workspace("e2e-offclose"),
      {
        name: "cb",
      },
    );
    await b.offline();
    await eventually(async () =>
      expect(await sa.hubRoster()).toContainEqual(
        expect.objectContaining({ bus_name: "cb", state: "queued" }),
      ),
    );
    const r = await sa.send("cb", "never");
    await cb.close();
    await eventually(() => expect(b.live(cb.ref)).toBe(false));
    await b.online();
    await eventually(() =>
      expect(a.receipts(r.msg_id)).toEqual(["expired: recipient_closed"]),
    );
    // Scenario 4b's "the sender is told".
    await eventually(() =>
      expect(a.notices()).toContainEqual({
        ref: sa.ref,
        text: '×  Expired: your message to cb, "never",\n   was not delivered because cb closed first.',
      }),
    );
    await cb.reopen();
    await eventually(() => expect(b.live(cb.ref)).toBe(true));
    await sleep(200);
    expect(cb.inbox()).toEqual([]);
  });

  it("a Pi sender is told on its own connection when its mail expires", async () => {
    const a = await mk("alpha");
    const b = await mk("beta");
    const sp = await a.session("pi", "pi-sender-1", workspace("e2e-pinote"), {
      name: "ps",
    });
    const cb = await b.session(
      "claude-code",
      "claude-ref-3",
      workspace("e2e-pinote"),
      { name: "cb" },
    );
    await b.offline();
    await eventually(async () =>
      expect(await sp.hubRoster()).toContainEqual(
        expect.objectContaining({ bus_name: "cb", state: "queued" }),
      ),
    );
    const r = await sp.send("cb", "never");
    await cb.close();
    await eventually(() => expect(b.live(cb.ref)).toBe(false));
    await b.online();
    await eventually(() =>
      expect(a.receipts(r.msg_id)).toEqual(["expired: recipient_closed"]),
    );
    await eventually(() =>
      expect(a.notices()).toEqual([
        {
          ref: sp.ref,
          text: '×  Expired: your message to cb, "never",\n   was not delivered because cb closed first.',
        },
      ]),
    );
  });

  it("severs with no close frame; held acks give one copy and no false delivered", async () => {
    const { a, b, sa, sb } = await pair("e2e-sever");
    b.holdAcks(true);
    const r = await sa.send("oc", "once");
    await eventually(() => expect(sb.inbox()).toHaveLength(1));
    await sleep(200);
    expect(a.receipts(r.msg_id)).toEqual([]);
    b.holdAcks(false);
    b.sever();
    await eventually(() => expect(b.closeCodes()).toContain(1006));
    // The hub pushes the unacked mail again; the daemon acks it without injecting.
    await eventually(() => expect(a.receipts(r.msg_id)).toEqual(["delivered"]));
    expect(sb.inbox()).toHaveLength(1);
  });

  it("injects a raw frame on a machine's link: another machine's from_ref is rejected", async () => {
    const { b, sa, sb } = await pair("e2e-spoof");
    const reply = await b.raw(
      ClientFrameSchema.parse({
        v: 1,
        id: frameId(),
        type: "send",
        from_ref: sa.ref,
        to_name: "oc",
        body: "spoofed",
      }),
    );
    expect(reply).toMatchObject({ type: "error", code: "not_registered" });
    // No receipt, and the link stays open.
    expect(b.closeCodes()).toEqual([]);
    expect(await sb.name()).toBe("oc");
    await sleep(200);
    expect(sb.inbox()).toEqual([]);
  });

  it("a fetch of mail not addressed to the agent reads exactly like an unknown id", async () => {
    const { sa, sb } = await pair("e2e-fetch");
    await sa.send("oc", "x".repeat(40_000));
    const notice = await eventually(() => {
      const [m] = sb.inbox();
      expect(m?.body).toContain(m?.msg_id);
      return m as NonNullable<typeof m>;
    });
    expect(await sa.fetch(notice.msg_id)).toMatchObject({
      type: "error",
      code: "not_found",
    });
    expect(
      sa.hubReply("fetch", (q) => q.msg_id === notice.msg_id),
    ).toMatchObject({ type: "error", code: "not_found" });
    expect(await sa.fetch(newId())).toMatchObject({
      type: "error",
      code: "not_found",
    });
    expect(await sb.fetch(notice.msg_id)).toMatchObject({
      type: "body",
      body: "x".repeat(40_000),
    });
  });

  it("sees a revoke: close code 4403, the exact log line, and the token refused", async () => {
    const a = await mk("alpha");
    await eventually(() => expect(hub?.connected()).toEqual([a.machineId]));
    await a.revoke();
    await eventually(() => expect(a.closeCodes()).toContain(4403));
    await eventually(() => expect(a.revoked()).toBe(true));
    expect(process.exitCode ?? 0).toBe(0);
    expect(await probeUpgrade(a.hub, a.token())).toBe(401);
  });

  it("dispose revokes the machine, and tolerates one already revoked", async () => {
    const a = await mk("alpha");
    const b = await mk("beta");
    await b.revoke();
    machines.splice(0);
    await a.dispose();
    await b.dispose();
    expect(hub?.revoked().sort()).toEqual([a.machineId, b.machineId].sort());
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

describe("seed mode", () => {
  const notLoopback = [
    "https://staging.open-bus.ai",
    "http://10.0.0.5:8787",
    "http://127.0.0.1.nip.io:8787",
    "http://localhost:8787",
    "http://127.0.0.2:8787",
  ];

  it("accepts only loopback IP literals, in their normalised forms too", () => {
    for (const hubUrl of notLoopback)
      expect(() => assertSeedHub(hubUrl)).toThrow(/loopback IP/);
    for (const ok of [
      "http://127.0.0.1:8787",
      "http://[::1]:8787",
      "http://0x7f.0.0.1:8787",
      "http://2130706433:8787",
      "http://[0:0:0:0:0:0:0:1]:8787",
    ])
      expect(() => assertSeedHub(ok)).not.toThrow();
  });

  it('E2E_SEED accepts only "1"', () => {
    expect(seedMode({})).toBe(false);
    expect(seedMode({ E2E_SEED: "" })).toBe(false);
    expect(seedMode({ E2E_SEED: "1" })).toBe(true);
    for (const v of ["0", "true", "yes", " 1", "1 "])
      expect(() => seedMode({ E2E_SEED: v })).toThrow(/accepts only "1"/);
  });

  it("pointed at a non-loopback hub, makes zero requests", async () => {
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      throw new Error("no request may be made");
    }) as typeof fetch;
    let probes = 0;
    const probe = async () => {
      probes++;
      return 401;
    };
    try {
      for (const hubUrl of notLoopback) {
        // The gate at module load: it throws before probing.
        await expect(
          liveHub({ E2E_HUB: hubUrl, E2E_SEED: "1" }, probe),
        ).rejects.toThrow(/loopback IP/);
        await expect(
          liveHub({ E2E_HUB: "http://127.0.0.1:1", E2E_SEED: "yes" }, probe),
        ).rejects.toThrow(/accepts only "1"/);
        expect(() => envMachineOptions(hubUrl, { E2E_SEED: "1" })).toThrow(
          /loopback IP/,
        );
        await expect(
          machine("x", {
            hub: hubUrl,
            rest: restSession(hubUrl, ""),
            seed: true,
          }),
        ).rejects.toThrow(/loopback IP/);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    expect({ fetches, probes }).toEqual({ fetches: 0, probes: 0 });
  });

  it("does not follow a redirect from the seed route", async () => {
    let followed = 0;
    const target = await server((_q, s) => {
      followed++;
      s.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const hubUrl = await server((_q, s) =>
      s.writeHead(307, { location: `${target}/__e2e/machine` }).end(),
    );
    await expect(
      machine("x", envMachineOptions(hubUrl, { E2E_SEED: "1" })),
    ).rejects.toThrow();
    expect(followed).toBe(0);
  });

  it("seeds a machine with no device flow, and dispose skips the revoke", async () => {
    const h = await setup();
    const opts = envMachineOptions(h.url, { E2E_SEED: "1" });
    expect(opts.seed).toBe(true);
    const m = await machine("seeded", opts);
    const file = join(m.home, "machine.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      hub: h.url,
      machine_id: m.machineId,
      label: "seeded",
    });
    await eventually(() => expect(h.connected()).toEqual([m.machineId]));
    // The local hub is throwaway: no revoke, so no error and no revoked machine.
    await m.dispose();
    expect(h.revoked()).toEqual([]);
    // There is no owner session to revoke with.
    await expect(opts.rest.revoke(m.machineId)).rejects.toThrow(
      /owner session/,
    );
  });
});

describe("liveHub gate", () => {
  it("skips when E2E_HUB is unset", async () => {
    expect(await liveHub({})).toEqual({
      state: "skip",
      reason: expect.stringMatching(/E2E_HUB is not set/),
    });
  });

  it("skips while /hub is 404", async () => {
    const url = await server((_q, s) => s.writeHead(404).end());
    expect(await liveHub({ E2E_HUB: url })).toEqual({
      state: "skip",
      reason: expect.stringMatching(/404/),
    });
  });

  it("fails when the hub is unreachable", async () => {
    expect(await liveHub({ E2E_HUB: "http://127.0.0.1:1" })).toMatchObject({
      state: "fail",
      reason: expect.stringMatching(/unreachable/),
    });
  });

  it("fails on a 5xx", async () => {
    const url = await server((_q, s) => s.writeHead(503).end());
    expect(await liveHub({ E2E_HUB: url })).toMatchObject({
      state: "fail",
      reason: expect.stringMatching(/503/),
    });
  });

  it("fails when an upgrade with no token is accepted", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const url = `http://127.0.0.1:${(wss.address() as { port: number }).port}`;
    try {
      expect(await liveHub({ E2E_HUB: url })).toMatchObject({
        state: "fail",
        reason: expect.stringMatching(/accepted an upgrade with no token/),
      });
    } finally {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });

  it("runs when an upgrade with no token gets 426", async () => {
    const url = await server((_q, s) => s.writeHead(426).end());
    expect(await liveHub({ E2E_HUB: url })).toEqual({ state: "run", hub: url });
  });

  it("runs when an upgrade with no token gets 401", async () => {
    const h = await setup();
    expect(await liveHub({ E2E_HUB: h.url })).toEqual({
      state: "run",
      hub: h.url,
    });
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
