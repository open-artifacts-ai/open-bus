import { type Ctx, say } from "../context.ts";
import type { Harness } from "../index.ts";

/** The modules whose import starts each harness's MCP server on stdio. */
export const MCP_ENTRY = {
  claude: "@ob/adapter-claude-code/main",
  opencode: "@ob/adapter-opencode/main",
} as const;

/** Runs the harness's MCP server; undefined means it keeps the process alive. */
export async function mcp(
  harness: Harness,
  ctx: Ctx,
  load: (m: string) => Promise<unknown> = (m) => import(m),
): Promise<number | undefined> {
  if (harness === "pi") {
    say(ctx, ctx.copy.mcpPi());
    return 1;
  }
  await load(MCP_ENTRY[harness]);
  return undefined;
}
