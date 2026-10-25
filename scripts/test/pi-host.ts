// A minimal Pi host for scripts/pi-linux-e2e.test.ts: loads the extension file
// at argv[2] as Pi does (its default export, given the Pi API) and drives it
// over the fork IPC channel. One session: PI_SESSION, PI_NAME, PI_CWD. With
// PI_AGENT set it plays oh-my-pi: ctx.agent is the root, and op "sub" starts an
// in-process subagent session, as omp's task tool does.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

type Json = Record<string, unknown>;
type Ctx = {
  cwd: string;
  sessionManager: { getSessionId(): string; getSessionName(): string };
  agent?: { kind: "main" | "sub" };
};
type Tool = {
  name: string;
  loadMode?: string;
  execute(
    id: string,
    params: Json,
    signal: undefined,
    onUpdate: undefined,
    ctx: Ctx,
  ): Promise<{ content: { text: string }[] }>;
};
type Request = { id: number; op: string; tool?: string; params?: Json };

const send = (m: Json) => process.send?.(m);
const ctxOf = (session: string, kind?: "main" | "sub"): Ctx => ({
  cwd: String(process.env.PI_CWD),
  sessionManager: {
    getSessionId: () => session,
    getSessionName: () => String(process.env.PI_NAME),
  },
  ...(kind ? { agent: { kind } } : {}),
});
const ctx = ctxOf(
  String(process.env.PI_SESSION),
  process.env.PI_AGENT ? "main" : undefined,
);
const sub = ctxOf(`${process.env.PI_SESSION}-sub`, "sub");
const tools = new Map<string, Tool>();
const handlers = new Map<string, ((e: unknown, c: Ctx) => unknown)[]>();
const emit = async (event: string, e: unknown, c: Ctx = ctx) => {
  for (const h of handlers.get(event) ?? []) await h(e, c);
};

/** `ps -o lstart=` for this process, under `env` on top of the inherited one. */
const lstart = (env: Record<string, string>) =>
  execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();

const extension = (await import(pathToFileURL(String(process.argv[2])).href))
  .default as (pi: unknown) => void;
extension({
  registerTool: (t: Tool) => tools.set(t.name, t),
  on: (event: string, h: (e: unknown, c: Ctx) => unknown) =>
    handlers.set(event, [...(handlers.get(event) ?? []), h]),
  sendMessage: (message: Json, options: Json) =>
    send({ event: "message", message, options }),
});

async function handle(r: Request): Promise<unknown> {
  switch (r.op) {
    case "start":
      return emit("session_start", { reason: "startup" });
    case "shutdown":
      return emit("session_shutdown", {});
    case "sub":
      return emit("session_start", { reason: "startup" }, sub);
    case "sub-shutdown":
      return emit("session_shutdown", {}, sub);
    case "call":
    case "sub-call": {
      const tool = tools.get(String(r.tool));
      if (!tool) throw new Error(`no tool ${r.tool}`);
      const out = await tool.execute(
        "c",
        r.params ?? {},
        undefined,
        undefined,
        r.op === "sub-call" ? sub : ctx,
      );
      return out.content.map((c) => c.text).join("");
    }
    case "lstart":
      return {
        // The extension's own call (assets/openbus.ts procStart).
        utc: lstart({ TZ: "UTC", LC_ALL: "C" }),
        // The same call without the override, in this process's TZ.
        inherited: lstart({}),
        tz: process.env.TZ,
      };
    default:
      throw new Error(`unknown op ${r.op}`);
  }
}

process.on("message", (r: Request) => {
  handle(r).then(
    (result) => send({ id: r.id, ok: true, result }),
    (e: unknown) =>
      send({
        id: r.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }),
  );
});
send({
  event: "ready",
  tools: [...tools.keys()].sort(),
  loadModes: [...new Set([...tools.values()].map((t) => t.loadMode ?? null))],
});
