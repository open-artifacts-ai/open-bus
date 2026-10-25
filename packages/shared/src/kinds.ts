import { z } from "zod";

export const AGENT_KINDS = ["claude-code", "opencode", "pi", "omp"] as const;
export const AgentKindSchema = z.enum(AGENT_KINDS);
export type AgentKind = z.infer<typeof AgentKindSchema>;
