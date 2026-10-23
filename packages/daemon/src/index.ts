import { isAbsolute, join } from "node:path";
import { claudeSessionsDir } from "@ob/adapter-claude-code";
import { serveDaemon } from "@ob/ipc";
import {
  type ClientFrame,
  ClientFrameSchema,
  frameId,
  WireNamespaceSchema,
} from "@ob/shared";
import { type AgentRecord, AgentTable } from "./agents.ts";
import { type Attest, attest, procStartOf } from "./attest.ts";
import { type Config, home, readConfig, socketPath } from "./config.ts";
import { createDeliver, type DeliverFn } from "./deliver.ts";
import { HubConnection, type HubOptions } from "./hub.ts";
import {
  cachedProcStart,
  claudeTarget,
  isRunning,
  liveClaudeSessions,
} from "./liveness/claude.ts";
import { type Namespace, resolveNamespace } from "./namespace.ts";
import { Outbox } from "./outbox.ts";
import { Pending, routeLocal } from "./routes.ts";
import { ClaudeTransport } from "./transports/claude.ts";

export * from "./agents.ts";
export * from "./attest.ts";
export * from "./config.ts";
export * from "./dedupe.ts";
export * from "./deliver.ts";
export * from "./hub.ts";
export * from "./liveness/claude.ts";
export * from "./namespace.ts";
export * from "./outbox.ts";
export * from "./routes.ts";
export * from "./transports/claude.ts";

export type DaemonDeps = {
  transports?: Partial<Record<AgentRecord["kind"], DeliverFn>>;
  version?: string;
  log?: (msg: string) => void;
  /** Test seams. */
  config?: Config;
  socketPath?: string;
  attest?: (hello: Parameters<typeof attest>[0]) => Attest;
  resolveNamespace?: (cwd: string) => Namespace;
  pendingTimeoutMs?: number;
  hub?: Partial<Pick<HubOptions, "backoffMs" | "pingMs" | "stableMs">>;
  claude?: {
    sessionsDir?: string;
    socketsDir?: string;
    statusWindowMs?: number;
    injectTimeoutMs?: number;
    heldFile?: string;
    syncMs?: number;
    procStart?: (pid: number) => string | null;
    isRunning?: (pid: number) => boolean;
  };
};

export type Daemon = {
  stop: () => Promise<void>;
  hub: HubConnection;
  agents: AgentTable;
};

export async function runDaemon(deps: DaemonDeps = {}): Promise<Daemon> {
  const cfg = deps.config ?? readConfig();
  const log = deps.log ?? ((msg: string) => console.error(`openbus: ${msg}`));
  const agents = new AgentTable();
  const pending = new Pending(deps.pendingTimeoutMs);
  /** Open local connections per agent_ref; the agent is closed when the last one goes. */
  const conns = new Map<string, number>();

  const sessions = () => ({
    open: agents.openRefs(),
    closed: agents.closedRefs(),
  });
  const announceSessions = () =>
    hub.send({ v: 1, id: frameId(), type: "sessions", ...sessions() });
  const announceUp = (rec: AgentRecord) =>
    hub.send({
      v: 1,
      id: frameId(),
      type: "agent_up",
      agent_ref: rec.ref,
      kind: rec.kind,
      proposed_name: rec.proposedName.slice(0, 64),
      namespace: rec.namespace,
      global: rec.global,
    });

  const resolveNs = (cwd: string, allowMissing: boolean) =>
    (
      deps.resolveNamespace ??
      ((dir) => resolveNamespace(dir, { log, allowMissing }))
    )(cwd);

  const cl = deps.claude ?? {};
  const running = cl.isRunning ?? isRunning;
  const claudeSessions = {
    dir: cl.sessionsDir ?? claudeSessionsDir(),
    procStart: cachedProcStart(cl.procStart ?? procStartOf, running),
    isRunning: running,
  };
  // A Claude reply must not be lost to a hub reconnect.
  const outbox = new Outbox<ClientFrame>({
    send: (f) => hub.send(f),
    stale: (f) => f.type === "send" && !agents.byRef(f.from_ref)?.live,
    log,
  });
  const claude = new ClaudeTransport({
    socketsDir: cl.socketsDir ?? join(home(), "claude-return"),
    heldFile: cl.heldFile ?? join(home(), "claude-held.json"),
    statusWindowMs: cl.statusWindowMs,
    injectTimeoutMs: cl.injectTimeoutMs,
    log,
    target: (ref) => claudeTarget(ref, claudeSessions),
    // A native reply is a message from the session: the sink names the sender, never the frame.
    onReply: (agentRef, peerName, body) => {
      const f: ClientFrame = {
        v: 1,
        id: frameId(),
        type: "send",
        from_ref: agentRef,
        to_name: peerName,
        body,
      };
      if (!ClientFrameSchema.safeParse(f).success) {
        log(`dropped a Claude reply to ${peerName}: not valid on the hub wire`);
        return;
      }
      outbox.push(f);
    },
  });

  /** Claude sessions exist before they call a tool: the daemon announces them from their session files. */
  const syncClaude = () => {
    const live = liveClaudeSessions(claudeSessions);
    const liveRefs = new Set(live.map((s) => s.ref));
    const livePid = (ref: string, pid: number) =>
      live.some((s) => s.ref === ref && s.pid === pid);
    for (const s of live) {
      const prev = agents.byRef(s.ref);
      if (prev && prev.kind !== "claude-code") continue;
      if (prev?.live) {
        // `claude --resume` brings the same session back under a new pid; while
        // the current one still runs it stays, so two files never flap.
        if (!livePid(s.ref, prev.pid)) prev.pid = s.pid;
        continue;
      }
      // Closed by a failed delivery and still the same process.
      if (prev && prev.pid === s.pid) continue;
      if (!isAbsolute(s.cwd)) continue;
      let ns: Namespace;
      try {
        ns = resolveNs(s.cwd, true);
      } catch {
        continue;
      }
      if (!WireNamespaceSchema.safeParse(ns.namespace).success) continue;
      announceUp(
        agents.up({
          ref: s.ref,
          kind: "claude-code",
          proposedName: s.name,
          busName: prev?.busName ?? s.name,
          namespace: ns.namespace,
          global: ns.global,
          pid: s.pid,
          cwd: s.cwd,
          live: true,
        }),
      );
    }
    let closed = false;
    for (const a of agents.all()) {
      if (a.kind !== "claude-code" || !a.live || liveRefs.has(a.ref)) continue;
      a.live = false;
      closed = true;
      void claude.drop(a.ref);
    }
    if (closed) announceSessions();
  };

  const delivery = createDeliver({
    agents,
    hub: { send: (f) => hub.send(f) },
    transports: {
      "claude-code": (agent, mail) => claude.deliver(agent, mail),
      ...deps.transports,
    },
    onClosed: announceSessions,
    log,
  });

  const hub = new HubConnection({
    url: `${cfg.hub.replace(/^http/, "ws").replace(/\/$/, "")}/hub`,
    token: cfg.machine_token,
    label: cfg.label,
    version: deps.version ?? process.env.OPENBUS_VERSION ?? "0.0.0",
    sessions,
    log,
    ...deps.hub,
    onFrame: (frame) => {
      switch (frame.type) {
        case "deliver":
          void delivery.deliver(frame);
          return;
        case "agent_ok": {
          const agent = agents.byRef(frame.agent_ref);
          if (agent) agent.busName = frame.bus_name;
          return;
        }
        case "receipt":
        case "roster":
        case "body":
        case "error":
          // An error answers one request by id; an unmatched one is dropped.
          pending.settle(frame);
          return;
        case "hello_ok":
          // Nothing to do: the machine id and label are already in machine.json.
          return;
        // receipt_update and roster_changed have no local consumer yet (C5/C6).
      }
    },
    onRevoked: () => {
      log("this machine was revoked; run `open-bus login`");
      process.exitCode = 1;
    },
    // The hub forgets agents with the link; sessions went out with hello.
    onOpen: () => {
      for (const rec of agents.all()) if (rec.live) announceUp(rec);
      outbox.flush();
    },
    onClose: () =>
      pending.failAll("hub_unavailable", "the hub connection dropped"),
  });

  const server = await serveDaemon({
    path: deps.socketPath ?? socketPath(),
    onHello: (hello) => {
      const check = (deps.attest ?? attest)(hello);
      if (!check.ok) return { error: check.reason };
      // Claude's MCP server is a new process per tool call; the session is the identity.
      const pid = check.pid ?? hello.pid;
      const prev = agents.byRef(hello.agent_ref);
      // A resumed session may beat the next sync tick: the files decide whose it is.
      if (prev?.live && prev.kind === "claude-code" && prev.pid !== pid) {
        const live = liveClaudeSessions(claudeSessions).filter(
          (s) => s.ref === prev.ref,
        );
        if (
          live.some((s) => s.pid === pid) &&
          !live.some((s) => s.pid === prev.pid)
        )
          prev.pid = pid;
      }
      if (prev?.live) {
        if (prev.kind !== hello.kind || prev.pid !== pid) {
          return { error: "agent_ref is in use by another session" };
        }
        // The same session reconnecting keeps its record: never re-homed.
        conns.set(prev.ref, (conns.get(prev.ref) ?? 0) + 1);
        return {
          bus_name: prev.busName,
          namespace: prev.namespace,
          global: prev.global,
        };
      }
      // Claude's session file names its cwd; other kinds state one.
      const cwd = check.cwd ?? hello.cwd;
      if (!isAbsolute(cwd)) return { error: "cwd must be absolute" };
      let ns: Namespace;
      try {
        // A live Claude session may have outlived its start directory.
        ns = resolveNs(cwd, check.cwd !== undefined);
      } catch {
        return { error: `cwd does not resolve: ${cwd}` };
      }
      if (!WireNamespaceSchema.safeParse(ns.namespace).success)
        return { error: `namespace is not valid on the wire: ${ns.namespace}` };
      const proposedName = hello.proposed_name ?? hello.agent_ref;
      const rec = agents.up({
        ref: hello.agent_ref,
        kind: hello.kind,
        proposedName,
        busName: prev?.busName ?? proposedName,
        namespace: ns.namespace,
        global: ns.global,
        pid,
        cwd,
        live: true,
      });
      conns.set(rec.ref, (conns.get(rec.ref) ?? 0) + 1);
      announceUp(rec);
      return {
        bus_name: rec.busName,
        namespace: rec.namespace,
        global: rec.global,
      };
    },
    onFrame: (frame, hello, reply) =>
      frame.type === "hello"
        ? undefined
        : routeLocal(frame, hello, reply, {
            agents,
            hub,
            pending,
            confirm: delivery.confirm,
          }),
    onClose: (hello) => {
      if (!hello) return;
      const left = (conns.get(hello.agent_ref) ?? 1) - 1;
      if (left > 0) {
        conns.set(hello.agent_ref, left);
        return;
      }
      conns.delete(hello.agent_ref);
      // Only pi lives as long as its connection. Claude's MCP server connects
      // per tool call (its liveness is the session files); OpenCode's is presence.
      if (hello.kind !== "pi") return;
      const rec = agents.byRef(hello.agent_ref);
      if (!rec) return;
      rec.live = false;
      announceSessions();
    },
  });

  const sync = () => {
    try {
      syncClaude();
    } catch (e) {
      log(
        `claude session sync failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  sync();
  const watcher = setInterval(sync, cl.syncMs ?? 2000);
  watcher.unref();

  hub.start();
  return {
    hub,
    agents,
    stop: async () => {
      clearInterval(watcher);
      hub.stop();
      pending.failAll("hub_unavailable", "the daemon is stopping");
      await Promise.all([server.close(), claude.close()]);
    },
  };
}
