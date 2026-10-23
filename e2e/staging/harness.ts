// The staging scenario harness (06-integration I7).
//
// `machine(label)` is one machine to the hub: a fresh OPENBUS_HOME, logged in
// through the real device flow (packages/cli login) and approved over REST with
// a stored browser session, then a real daemon (packages/daemon runDaemon) on
// its own local socket. `machine.session(...)` is a fake harness session that
// speaks the adapter socket contract (packages/ipc connectDaemon).
//
// The daemon runs in-process with the seams its own tests use: attestation is
// the real `attest()` fed harness evidence (a fake ~/.claude/sessions dir, an
// OpenCode presence set, Pi start times), and delivery goes to an in-memory
// inbox per session instead of a real harness. Between each daemon and the hub
// sits a transparent WebSocket tap, so a test can read the hub's
// receipt_update frames and close codes, which the daemon does not surface.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attest,
  type Daemon,
  type DeliverFn,
  type Mail,
  readConfig,
  runDaemon,
} from "@ob/daemon";
import {
  connectDaemon,
  type DaemonClient,
  type DaemonFrame,
  Hello,
  type Kind,
} from "@ob/ipc";
import {
  ApprovalBodySchema,
  CONFIG_FILE,
  CSRF_HEADER,
  CSRF_VALUE,
  DeviceCodeResponseSchema,
  decodeServerFrame,
  frameId,
  OpenBusConfigSchema,
  PONG,
  R,
  type ServerFrame,
} from "@ob/shared";
import WebSocket, { type RawData, WebSocketServer } from "ws";
// Imported by path: the CLI package is named `open-bus`, like the workspace root.
import { login } from "../../packages/cli/src/commands/login.ts";

// ── small utilities ────────────────────────────────────────────────────────

/** A fresh private directory. Short, because a Unix socket path is capped near 104 bytes. */
export function tmpDir(prefix = "e2e"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `ob-${prefix}-`)));
}

/** A directory whose `.openbus.json` sets the namespace (and, if asked, global). */
export function workspace(
  namespace: string,
  o: { global?: boolean } = {},
): string {
  const dir = tmpDir("ws");
  // Validated, but written as given: the daemon normalizes it as it would a user's file.
  const raw = { namespace, ...(o.global ? { global: true } : {}) };
  OpenBusConfigSchema.parse(raw);
  const file = join(dir, CONFIG_FILE);
  writeFileSync(file, `${JSON.stringify(raw)}\n`);
  chmodSync(file, 0o644);
  return dir;
}

/** Retries `fn` until it stops throwing, then returns its value. */
export async function eventually<T>(
  fn: () => T | Promise<T>,
  o: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (o.timeoutMs ?? 15_000);
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await sleep(o.intervalMs ?? 100);
    }
  }
}

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));
const wsUrl = (hub: string) =>
  `${hub.replace(/^http/, "ws").replace(/\/+$/, "")}${R.hub}`;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── the gate ───────────────────────────────────────────────────────────────

export type Gate = { ok: true; hub: string } | { ok: false; reason: string };

/** The suite runs once E2E_HUB is set and its `/hub` upgrade route exists (anything but 404). */
export async function liveHub(
  env: Record<string, string | undefined> = process.env,
): Promise<Gate> {
  const hub = env.E2E_HUB?.replace(/\/+$/, "");
  if (!hub) return { ok: false, reason: "E2E_HUB is not set" };
  try {
    const res = await fetch(`${hub}${R.hub}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel();
    if (res.status === 404)
      return {
        ok: false,
        reason: `GET ${hub}${R.hub} is 404: the hub is not deployed yet`,
      };
    return { ok: true, hub };
  } catch (e) {
    return { ok: false, reason: `${hub} is unreachable: ${msg(e)}` };
  }
}

// ── the browser session (approve, revoke) ──────────────────────────────────

type StorageState = {
  cookies?: {
    name: string;
    value: string;
    domain: string;
    path?: string;
    expires?: number;
  }[];
};

/** The Cookie header a browser would send to `url`, from a Playwright storage state file. */
export function cookieHeader(stateFile: string, url: string): string {
  const u = new URL(url);
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as StorageState;
  const now = Date.now() / 1000;
  return (state.cookies ?? [])
    .filter((c) => {
      const d = c.domain.replace(/^\./, "");
      const domainOk =
        u.hostname === d ||
        (c.domain.startsWith(".") && u.hostname.endsWith(`.${d}`));
      const pathOk = u.pathname.startsWith(c.path ?? "/");
      const fresh = c.expires === undefined || c.expires < 0 || c.expires > now;
      return domainOk && pathOk && fresh;
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** What the user does in a browser: approve a device code, revoke a machine. */
export type RestSession = {
  approve: (userCode: string) => Promise<void>;
  revoke: (machineId: string) => Promise<void>;
};

export function restSession(hub: string, cookie: string): RestSession {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${hub.replace(/\/+$/, "")}${path}`, {
      method,
      redirect: "manual",
      headers: {
        cookie,
        [CSRF_HEADER]: CSRF_VALUE,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      // The body is the hub's error JSON; it never holds a token.
      throw new Error(
        `${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    }
  };
  return {
    approve: (userCode) =>
      call(
        "POST",
        R.approve(userCode),
        ApprovalBodySchema.parse({ decision: "approve" }),
      ),
    revoke: (machineId) => call("DELETE", R.machine(machineId)),
  };
}

/** The staging browser session: one real Access login by the user, saved as a storage state. */
export function stagingRest(
  hub: string,
  env: Record<string, string | undefined> = process.env,
): RestSession {
  const file = env.E2E_STORAGE_STATE;
  if (!file)
    throw new Error(
      "E2E_STORAGE_STATE is not set: it needs one real Access login by the user (file a blocker with scripts/ob-blocker.sh)",
    );
  return restSession(hub, cookieHeader(file, hub));
}

/** The status the hub answers a `/hub` upgrade with this token: 101 if accepted. */
export function probeUpgrade(hub: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(hub), {
      headers: { authorization: `Bearer ${token}` },
    });
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => {
      resolve(101);
      ws.close();
    });
    ws.on("error", (e) => reject(e));
  });
}

// ── the tap between a daemon and the hub ───────────────────────────────────

type Tap = { url: string; close: () => Promise<void> };

/** A hub `receipt` read by string, so a reason newer than @ob/shared is still seen. */
export type RawReceipt = {
  id: string;
  msg_id: string;
  state: string;
  reason?: string;
};
function looseReceipt(text: string): RawReceipt | undefined {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (o.type !== "receipt" || typeof o.state !== "string") return undefined;
    return {
      id: String(o.id),
      msg_id: String(o.msg_id),
      state: o.state,
      ...(typeof o.reason === "string" ? { reason: o.reason } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Forwards one daemon's hub link verbatim, reporting each hub frame and close code. */
async function tap(
  upstream: string,
  on: {
    frame: (f: ServerFrame) => void;
    /** Every `receipt` as sent, even one this build's schema rejects (a newer reason). */
    rawReceipt: (r: RawReceipt) => void;
    close: (code: number) => void;
  },
): Promise<Tap> {
  const links = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  const server: Server = createServer((_q, s) => s.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
    const up = new WebSocket(wsUrl(upstream), {
      headers: { authorization: req.headers.authorization ?? "" },
    });
    links.add(up);
    let client: WebSocket | undefined;
    const early: RawData[] = [];
    up.on("unexpected-response", (_r, res) => {
      res.resume();
      // A refused upgrade (401/403 on a revoked token) reaches the daemon as is.
      socket.end(
        `HTTP/1.1 ${res.statusCode} Refused\r\nContent-Length: 0\r\n\r\n`,
      );
      up.terminate();
    });
    up.on("error", () => {
      if (!client) socket.destroy();
    });
    up.on("open", () => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        client = ws;
        links.add(ws);
        for (const d of early.splice(0)) ws.send(d, { binary: false });
        ws.on("message", (d) => {
          if (up.readyState === WebSocket.OPEN) up.send(d, { binary: false });
        });
        ws.on("close", () => up.close());
      });
    });
    up.on("message", (d) => {
      const text = String(d);
      if (text !== PONG) {
        const r = decodeServerFrame(text);
        if (r.ok) on.frame(r.frame);
        const raw = looseReceipt(text);
        if (raw) on.rawReceipt(raw);
      }
      if (client) client.send(d, { binary: false });
      else early.push(d);
    });
    up.on("close", (code, reason) => {
      on.close(code);
      // 1005/1006 cannot be sent: the daemon sees a dropped link, as it would.
      if (code === 1005 || code === 1006) client?.terminate();
      else client?.close(code, reason);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => {
      for (const l of links) l.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// ── machines and sessions ──────────────────────────────────────────────────

export type MachineOptions = {
  /** The hub's https origin (or a loopback http one). */
  hub: string;
  rest: RestSession;
  /** Device-flow poll delay; defaults to the hub's own interval. */
  pollMs?: number;
  log?: (line: string) => void;
};

export type Receipt = Extract<DaemonFrame, { type: "receipt" }>;
export type RosterEntry = Extract<
  DaemonFrame,
  { type: "roster" }
>["agents"][number];

export type Session = {
  ref: string;
  kind: Kind;
  socketPath: string;
  /** The bus name the hub assigned, read with `self`. */
  name: () => Promise<string>;
  send: (to: string, body: string) => Promise<Receipt>;
  roster: () => Promise<RosterEntry[]>;
  /** Everything the daemon injected into this session, oldest first. */
  inbox: () => Mail[];
  /** The harness closes the session: its liveness evidence goes and its adapter disconnects. */
  closeTui: () => Promise<void>;
  close: () => Promise<void>;
};

export type Machine = {
  label: string;
  home: string;
  machineId: string;
  /** The hub this machine logged in to. */
  hub: string;
  token: () => string;
  session: (
    kind: Kind,
    agentRef: string,
    cwd: string,
    o?: { name?: string; attested?: boolean },
  ) => Promise<Session>;
  /** Drops and restores the hub link while the daemon and its sessions stay up. */
  offline: () => Promise<void>;
  online: () => Promise<void>;
  /** Stops the daemon; `start` runs a new one on the same OPENBUS_HOME and re-hellos open sessions. */
  stop: () => Promise<void>;
  start: () => Promise<void>;
  revoke: () => Promise<void>;
  /** The daemon saw its machine revoked. */
  revoked: () => boolean;
  /** Close codes the hub sent on this machine's links, in order. */
  closeCodes: () => number[];
  /** Every send receipt the hub sent this machine, read by string, oldest first. */
  rawReceipts: () => RawReceipt[];
  /** States from the hub's receipt_update frames for msg_id, in order. */
  receipts: (msgId: string) => string[];
  dispose: () => Promise<void>;
};

const PROC_START = "Thu Oct 22 10:00:00 2026";
let nextPid = 4_000_000;

/** Logs a fresh OPENBUS_HOME in to `opts.hub`, approves it, and starts its daemon. */
export async function machine(
  label: string,
  opts: MachineOptions,
): Promise<Machine> {
  const hub = opts.hub.replace(/\/+$/, "");
  const home = tmpDir("m");
  const log = opts.log ?? (() => {});

  // 1. Device login, approved over REST the moment the code is minted.
  let approval: Promise<void> | undefined;
  const tapFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (String(input).endsWith(R.deviceCode) && res.ok) {
      const code = DeviceCodeResponseSchema.parse(await res.clone().json());
      approval = opts.rest.approve(code.user_code);
      approval.catch(() => {});
    }
    return res;
  };
  let result: Awaited<ReturnType<typeof login>>;
  try {
    result = await login({
      hub,
      home,
      label,
      noOpen: true,
      fetch: tapFetch,
      openBrowser: async () => false,
      sleep: (ms) => sleep(opts.pollMs ?? ms),
      now: Date.now,
      print: log,
    });
    await approval;
  } catch (e) {
    await approval; // an approval failure explains a timed-out login better
    throw e;
  }

  // 2. The daemon's own config reader, pointed at this home.
  const prev = {
    home: process.env.OPENBUS_HOME,
    hubEnv: process.env.OPENBUS_HUB,
  };
  process.env.OPENBUS_HOME = home;
  delete process.env.OPENBUS_HUB;
  let cfg: ReturnType<typeof readConfig>;
  try {
    cfg = readConfig();
  } finally {
    restoreEnv("OPENBUS_HOME", prev.home);
    restoreEnv("OPENBUS_HUB", prev.hubEnv);
  }

  // 3. Harness evidence the real attest() checks, and per-session inboxes.
  const claudeDir = join(home, "claude-sessions");
  mkdirSync(claudeDir, { mode: 0o700 });
  const tuiOpen = new Set<string>();
  const piStarts = new Map<number, string>();
  const inboxes = new Map<string, Mail[]>();
  const sessions: SessionImpl[] = [];
  const alive = (kind: Kind, ref: string, pid: number) =>
    kind === "opencode"
      ? tuiOpen.has(ref)
      : kind === "pi"
        ? piStarts.has(pid)
        : claudeFile(pid) !== undefined;
  const claudeFile = (pid: number) => {
    try {
      return readFileSync(join(claudeDir, `${pid}.json`), "utf8");
    } catch {
      return undefined;
    }
  };
  const inject: DeliverFn = async (agent, mail) => {
    if (!alive(agent.kind, agent.ref, agent.pid))
      return { ok: false, reason: "closed" };
    const box = inboxes.get(agent.ref) ?? [];
    box.push(mail);
    inboxes.set(agent.ref, box);
    return { ok: true };
  };

  // 4. The tap, then the daemon behind it.
  const closeCodes: number[] = [];
  const receipts = new Map<string, string[]>();
  const rawReceipts: RawReceipt[] = [];
  const link = await tap(hub, {
    rawReceipt: (r) => rawReceipts.push(r),
    frame: (f) => {
      if (f.type === "receipt_update")
        receipts.set(f.msg_id, [...(receipts.get(f.msg_id) ?? []), f.state]);
    },
    close: (code) => closeCodes.push(code),
  });
  const socketPath = join(home, "daemon.sock");
  let revoked = false;
  let daemon: Daemon | undefined;
  const start = async () => {
    daemon = await runDaemon({
      config: { ...cfg, hub: link.url },
      socketPath,
      transports: { "claude-code": inject, opencode: inject, pi: inject },
      attest: (hello) =>
        attest(hello, {
          sessionsDir: claudeDir,
          ancestors: (pid) => [pid],
          procStart: (pid) =>
            piStarts.get(pid) ?? (claudeFile(pid) ? PROC_START : null),
          openSessions: () => tuiOpen,
        }),
      hub: { backoffMs: () => 250 },
      log: (line) => {
        log(`${label}: ${line}`);
        if (/revoked/.test(line)) {
          revoked = true;
          // runDaemon marks the process failed on revoke; this process is the test runner.
          const code = process.exitCode;
          queueMicrotask(() => {
            process.exitCode = code;
          });
        }
      },
    });
  };
  await start();

  type SessionImpl = Session & {
    reconnect: () => Promise<void>;
    ended: boolean;
  };

  const session: Machine["session"] = async (kind, ref, cwd, o = {}) => {
    const pid = nextPid++;
    if (o.attested !== false) {
      if (kind === "opencode") tuiOpen.add(ref);
      else if (kind === "pi") piStarts.set(pid, PROC_START);
      else
        writeFileSync(
          join(claudeDir, `${pid}.json`),
          JSON.stringify({ pid, sessionId: ref, procStart: PROC_START, cwd }),
        );
    }
    const hello = Hello.parse({
      v: 1,
      id: frameId(),
      type: "hello",
      kind,
      agent_ref: ref,
      pid,
      cwd,
      ...(o.name ? { proposed_name: o.name } : {}),
      attest: kind === "pi" ? { proc_start: PROC_START } : {},
    });
    let client: DaemonClient = await connectDaemon({ path: socketPath, hello });
    const ask = async (frame: Parameters<DaemonClient["request"]>[0]) => {
      const r = await client.request(frame);
      if (r.type === "error")
        throw new Error(`${frame.type} failed: ${r.code}: ${r.message}`);
      return r;
    };
    const end = async () => {
      if (kind === "opencode") tuiOpen.delete(ref);
      else if (kind === "pi") piStarts.delete(pid);
      else rmSync(join(claudeDir, `${pid}.json`), { force: true });
      s.ended = true;
      client.close();
    };
    const s: SessionImpl = {
      ref,
      kind,
      socketPath,
      ended: false,
      name: async () => {
        const r = await ask({ type: "self" });
        if (r.type !== "agent" || !r.agent)
          throw new Error(`self: unexpected ${r.type}`);
        return r.agent.name;
      },
      send: async (to, body) => {
        const r = await ask({ type: "send", to, body });
        if (r.type !== "receipt") throw new Error(`send: unexpected ${r.type}`);
        return r;
      },
      roster: async () => {
        const r = await ask({ type: "list" });
        if (r.type !== "roster") throw new Error(`list: unexpected ${r.type}`);
        return r.agents;
      },
      inbox: () => [...(inboxes.get(ref) ?? [])],
      closeTui: end,
      close: end,
      reconnect: async () => {
        client = await connectDaemon({
          path: socketPath,
          hello: { ...hello, id: frameId() },
        });
      },
    };
    sessions.push(s);
    // Barrier: the hub answers in order, so once a `list` round-trips its
    // agent_ok has landed and `name()` is the hub's bus name, not the proposal.
    if (o.attested !== false) await s.roster().catch(() => {});
    return s;
  };

  return {
    label,
    home,
    hub,
    machineId: result.machineId,
    token: () => cfg.machine_token,
    session,
    offline: async () => daemon?.hub.stop(),
    online: async () => daemon?.hub.start(),
    stop: async () => {
      await daemon?.stop();
      daemon = undefined;
    },
    start: async () => {
      if (daemon) return;
      await start();
      for (const s of sessions) if (!s.ended) await s.reconnect();
    },
    revoke: () => opts.rest.revoke(result.machineId),
    revoked: () => revoked,
    closeCodes: () => [...closeCodes],
    rawReceipts: () => [...rawReceipts],
    receipts: (id) => [...(receipts.get(id) ?? [])],
    dispose: async () => {
      for (const s of sessions) if (!s.ended) await s.close();
      await daemon?.stop();
      await link.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
