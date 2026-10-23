import { callTool, TOOLS, type ToolResult } from "@ob/adapter-claude-code";
import { type DaemonClient, Hello } from "@ob/ipc";
import type { OpenCodeSession } from "./session.ts";

export { TOOLS, type ToolResult };

/** OpenCode sets this on every tools/call; the model does not control it. */
export const SESSION_META = "ai.opencode/sessionID";

const text = (t: string): ToolResult => ({
  content: [{ type: "text", text: t }],
  isError: true,
});

/**
 * One OpenCode service hosts every session's MCP calls, so identity is per
 * call: `_meta`'s session id, mapped to its root. Tool arguments never name
 * the sender. One daemon connection per call, closed after it.
 */
export async function handleToolCall(input: {
  name: string;
  args: Record<string, unknown>;
  meta: Record<string, unknown> | undefined;
  connect: (hello: Hello) => Promise<DaemonClient>;
  resolve: (sessionId: string) => Promise<OpenCodeSession | null>;
}): Promise<ToolResult> {
  try {
    const sessionId = input.meta?.[SESSION_META];
    if (typeof sessionId !== "string" || !sessionId)
      return text("openbus: this OpenCode version did not send a session id.");
    const session = await input.resolve(sessionId);
    if (!session)
      return text(`openbus: OpenCode could not find session ${sessionId}.`);
    if (!session.directory)
      return text(
        `openbus: OpenCode did not say which directory session ${session.root} is in.`,
      );
    const hello = Hello.parse({
      v: 1,
      id: "hello",
      type: "hello",
      kind: "opencode",
      agent_ref: session.root,
      pid: process.pid,
      cwd: session.directory,
      attest: { session_id: sessionId },
    });
    let client: DaemonClient;
    try {
      client = await input.connect(hello);
    } catch (e) {
      return text(
        `openbus: the daemon did not accept this session (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
    try {
      return await callTool(input.name, input.args, client);
    } finally {
      client.close();
    }
  } catch (e) {
    // The service is shared by every session: a throw here would take them all.
    return text(`openbus: ${e instanceof Error ? e.message : String(e)}`);
  }
}
