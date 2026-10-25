// A minimal Pi host for scripts/pi-linux-e2e.test.ts: loads the extension file
// at argv[2] as Pi does (its default export, given the Pi API) and drives it
// over the fork IPC channel. One session: PI_SESSION, PI_NAME, PI_CWD.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

type Json = Record<string, unknown>;
type Ctx = {
  cwd: string;
  sessionManager: { getSessionId(): string; getSessionName(): string };
};
type Tool = {
  name: string;
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
const ctx: Ctx = {
  cwd: String(process.env.PI_CWD),
  sessionManager: {
    getSessionId: () => String(process.env.PI_SESSION),
    getSessionName: () => String(process.env.PI_NAME),
  },
};
const tools = new Map<string, Tool>();
const handlers = new Map<string, ((e: unknown, c: Ctx) => unknown)[]>();
const emit = async (event: string, e: unknown) => {
  for (const h of handlers.get(event) ?? []) await h(e, ctx);
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
    case "call": {
      const tool = tools.get(String(r.tool));
      if (!tool) throw new Error(`no tool ${r.tool}`);
      const out = await tool.execute(
        "c",
        r.params ?? {},
        undefined,
        undefined,
        ctx,
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
send({ event: "ready", tools: [...tools.keys()].sort() });
