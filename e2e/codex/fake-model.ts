// A fake OpenAI Responses API for the Codex e2e (C26g): Codex's
// `[model_providers.stub]` points here, so no API key and no network.
//
// The script, per turn: a user message with a line `ob-e2e send <to> <text>`
// (a prompt, or the body of a woken turn's message) calls openbus
// `list_agents`, then `send_message` to <to>, then answers with the tool's
// output as text. Any other user message gets a one-line text answer. Every request is recorded with the
// thread Codex names in its `thread-id` header, so the test asserts on what
// the model actually saw.
import { createServer, type Server } from "node:http";

/** The prompt that starts the scripted turn. */
export const SCRIPT = /^ob-e2e send (\S+) (.+)$/m;
const NAMESPACE = "mcp__openbus";

type Item = {
  type: string;
  role?: string;
  name?: string;
  namespace?: string;
  call_id?: string;
  arguments?: string;
  content?: unknown;
  output?: unknown;
};

/** One /responses request, reduced to what the tests read. */
export type Seen = {
  thread: string;
  /** The last user message's text in the request. */
  user: string;
  /** The last item: what this request answers. */
  last: Item;
  /** The text of a function_call_output, when `last` is one. */
  output?: string;
  /** The tool call `last` answers, when it is a function_call_output. */
  answers?: string;
};

export type FakeModel = {
  url: string;
  seen: Seen[];
  /**
   * Awaited before each openbus tool call is answered. The daemon admits a
   * call only from the second after its codex process started (lstart has
   * one-second resolution), and this model answers in milliseconds.
   */
  hold?: (tool: string) => Promise<void>;
  close: () => Promise<void>;
};

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((c) => (typeof c?.text === "string" ? c.text : ""))
          .join("\n")
      : "";

export async function fakeModel(): Promise<FakeModel> {
  const seen: Seen[] = [];
  const model: Omit<FakeModel, "url" | "close"> = { seen };
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.method !== "POST" || !req.url?.endsWith("/responses")) {
      res.writeHead(404).end();
      return;
    }
    const input = (JSON.parse(raw) as { input: Item[] }).input;
    const last = input[input.length - 1] as Item;
    const users = input.filter(
      (i) => i.type === "message" && i.role === "user",
    );
    const user = textOf(users[users.length - 1]?.content);
    const call =
      last.type === "function_call_output"
        ? input.find(
            (i) => i.type === "function_call" && i.call_id === last.call_id,
          )
        : undefined;
    const output =
      last.type === "function_call_output" ? textOf(last.output) : undefined;
    seen.push({
      thread: String(req.headers["thread-id"] ?? ""),
      user,
      last,
      ...(output !== undefined ? { output } : {}),
      ...(call?.name ? { answers: call.name } : {}),
    });

    const id = ++n;
    const tool = (name: string, args: object): object => ({
      type: "function_call",
      id: `fc_${id}`,
      call_id: `call_${id}`,
      name,
      namespace: NAMESPACE,
      arguments: JSON.stringify(args),
    });
    const say = (text: string): object => ({
      type: "message",
      role: "assistant",
      id: `msg_${id}`,
      content: [{ type: "output_text", text }],
    });
    const script = SCRIPT.exec(user);
    let item: object;
    if (script && last.type === "message") item = tool("list_agents", {});
    else if (script && call?.name === "list_agents")
      item = tool("send_message", { to: script[1], text: script[2] });
    else if (call) item = say(`done: ${output}`);
    else item = say(`seen: ${user.slice(0, 80)}`);
    if ((item as Item).type === "function_call")
      await model.hold?.(String((item as Item).name));

    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type: string, o: object) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    const response = { id: `resp_${id}` };
    event("response.created", { response });
    event("response.output_item.done", { item });
    event("response.completed", {
      response: {
        ...response,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: null,
          output_tokens_details: null,
        },
      },
    });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return Object.assign(model, {
    url: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  });
}
