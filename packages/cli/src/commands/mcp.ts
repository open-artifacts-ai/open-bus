import { type Ctx, say } from "../context.ts";
import type { Harness } from "../index.ts";

/**
 * Each harness's MCP server: importing its main starts it on stdio. Literal
 * imports, so the bundle carries both.
 */
export const MCP_SERVER = {
  claude: () => import("@ob/adapter-claude-code/main"),
  opencode: () => import("@ob/adapter-opencode/main"),
} as const;

type McpHarness = keyof typeof MCP_SERVER;

/** Runs the harness's MCP server; undefined means it keeps the process alive. */
export async function mcp(
  harness: Harness,
  ctx: Ctx,
  load: (h: McpHarness) => Promise<unknown> = (h) => MCP_SERVER[h](),
): Promise<number | undefined> {
  if (harness === "pi") {
    say(ctx, ctx.copy.mcpPi());
    return 1;
  }
  await load(harness);
  return undefined;
}
