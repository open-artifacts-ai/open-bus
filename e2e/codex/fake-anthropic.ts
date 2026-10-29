// A fake Anthropic Messages API for the Claude Code leg of the e2e (C26g):
// `claude -p` runs with ANTHROPIC_BASE_URL pointing here and a dummy key, so
// no login and no network. The same script as fake-model.ts: a user message
// with a line `ob-e2e send <to> <text>` calls `mcp__openbus__list_agents`,
// then `mcp__openbus__send_message`, then answers with the tool's output; a
// line `ob-e2e tools <json>` calls each listed openbus tool in turn.
import { createServer, type Server } from "node:http";
import { SCRIPT, TOOLS } from "./fake-model.ts";

const PREFIX = "mcp__openbus__";

type Block = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: unknown;
};
type Message = { role: string; content: string | Block[] };

/** One /v1/messages request, reduced to what the tests read. */
export type SeenMessage = {
  /** Every user text in the request, joined. */
  user: string;
  /** The tool a tool_result in the last message answers, and its text. */
  answers?: string;
  output?: string;
};

export type FakeAnthropic = {
  url: string;
  seen: SeenMessage[];
  /** Awaited before each request is answered, once it is in `seen`. */
  hold?: (s: SeenMessage) => Promise<void>;
  close: () => Promise<void>;
};

const blocks = (m: Message | undefined): Block[] =>
  !m
    ? []
    : typeof m.content === "string"
      ? [{ type: "text", text: m.content }]
      : m.content;
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((c) => (typeof c?.text === "string" ? c.text : ""))
          .join("\n")
      : "";

export async function fakeAnthropic(): Promise<FakeAnthropic> {
  const seen: SeenMessage[] = [];
  const fake: Omit<FakeAnthropic, "url" | "close"> = { seen };
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = req.url?.split("?")[0];
    if (req.method === "POST" && path === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    if (req.method !== "POST" || path !== "/v1/messages") {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw) as { messages: Message[]; stream?: boolean };
    // Claude Code interleaves `system` messages (token budgets): skip them.
    const msgs = body.messages.filter((m) => m.role !== "system");
    const user = msgs
      .filter((m) => m.role === "user")
      .flatMap((m) => blocks(m))
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    const result = blocks(msgs[msgs.length - 1]).find(
      (b) => b.type === "tool_result",
    );
    const call = result
      ? msgs
          .flatMap((m) => (m.role === "assistant" ? blocks(m) : []))
          .find((b) => b.type === "tool_use" && b.id === result.tool_use_id)
      : undefined;
    const answers = call?.name?.startsWith(PREFIX)
      ? call.name.slice(PREFIX.length)
      : call?.name;
    const output = result ? textOf(result.content) : undefined;
    const s: SeenMessage = {
      user,
      ...(answers ? { answers } : {}),
      ...(output !== undefined ? { output } : {}),
    };
    seen.push(s);
    await fake.hold?.(s);

    const id = ++n;
    const script = SCRIPT.exec(user);
    const calls = TOOLS.exec(user);
    // The tool results since the message that holds the tools line.
    let from = 0;
    msgs.forEach((m, i) => {
      if (blocks(m).some((b) => b.type === "text" && TOOLS.test(b.text ?? "")))
        from = i;
    });
    const done = msgs
      .slice(from)
      .flatMap((m) => blocks(m))
      .filter((b) => b.type === "tool_result").length;
    const todo = calls
      ? (JSON.parse(calls[1]) as [string, object][])[done]
      : undefined;
    let block: Block & { input?: object };
    if (todo)
      block = {
        type: "tool_use",
        id: `toolu_${id}`,
        name: `${PREFIX}${todo[0]}`,
        input: todo[1],
      };
    else if (script && !result)
      block = {
        type: "tool_use",
        id: `toolu_${id}`,
        name: `${PREFIX}list_agents`,
        input: {},
      };
    else if (script && answers === "list_agents")
      block = {
        type: "tool_use",
        id: `toolu_${id}`,
        name: `${PREFIX}send_message`,
        input: { to: script[1], text: script[2] },
      };
    else block = { type: "text", text: result ? `done: ${output}` : "ok" };
    const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
    const usage = { input_tokens: 1, output_tokens: 1 };
    const message = {
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      model: "claude-fake",
      stop_sequence: null,
    };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...message,
          content: [block],
          stop_reason: stop,
          usage,
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type: string, o: object) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    event("message_start", {
      message: { ...message, content: [], stop_reason: null, usage },
    });
    if (block.type === "tool_use") {
      event("content_block_start", {
        index: 0,
        content_block: { ...block, input: {} },
      });
      event("content_block_delta", {
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input),
        },
      });
    } else {
      event("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      });
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: block.text },
      });
    }
    event("content_block_stop", { index: 0 });
    event("message_delta", {
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    event("message_stop", {});
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  });
}
