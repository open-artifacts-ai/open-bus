import { isAbsolute } from "node:path";
import { serveDaemon } from "@ob/ipc";
import { frameId, WireNamespaceSchema } from "@ob/shared";
import { type AgentRecord, AgentTable } from "./agents.ts";
import { type Attest, attest } from "./attest.ts";
import { type Config, readConfig, socketPath } from "./config.ts";
import { createDeliver, type DeliverFn } from "./deliver.ts";
import { HubConnection, type HubOptions } from "./hub.ts";
import { type Namespace, resolveNamespace } from "./namespace.ts";
import { Pending, routeLocal } from "./routes.ts";

export * from "./agents.ts";
export * from "./attest.ts";
export * from "./config.ts";
export * from "./dedupe.ts";
export * from "./deliver.ts";
export * from "./hub.ts";
export * from "./namespace.ts";
export * from "./routes.ts";

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

  const delivery = createDeliver({
    agents,
    hub: { send: (f) => hub.send(f) },
    transports: deps.transports ?? {},
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
          pending.settle(frame);
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
    },
    onClose: () =>
      pending.failAll("hub_unavailable", "the hub connection dropped"),
  });

  const server = await serveDaemon({
    path: deps.socketPath ?? socketPath(),
    onHello: (hello) => {
      const check = (deps.attest ?? attest)(hello);
      if (!check.ok) return { error: check.reason };
      const prev = agents.byRef(hello.agent_ref);
      if (prev?.live) {
        if (prev.kind !== hello.kind || prev.pid !== hello.pid) {
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
        const allowMissing = check.cwd !== undefined;
        ns = (
          deps.resolveNamespace ??
          ((dir) => resolveNamespace(dir, { log, allowMissing }))
        )(cwd);
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
        pid: hello.pid,
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
      const rec = agents.byRef(hello.agent_ref);
      if (!rec) return;
      rec.live = false;
      announceSessions();
    },
  });

  hub.start();
  return {
    hub,
    agents,
    stop: async () => {
      hub.stop();
      pending.failAll("hub_unavailable", "the daemon is stopping");
      await server.close();
    },
  };
}
