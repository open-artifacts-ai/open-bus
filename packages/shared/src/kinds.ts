import { z } from "zod";

export const AGENT_KINDS = ["claude-code", "opencode", "pi", "omp"] as const;
export const AgentKindSchema = z.enum(AGENT_KINDS);
export type AgentKind = z.infer<typeof AgentKindSchema>;

/**
 * The first client version whose roster decoder accepts the `omp` kind. The
 * hub omits omp roster rows for daemons below it (CONTRACT.md, version
 * gating). Predicted, not observed: verify it against the release tag that
 * first ships `omp` in AGENT_KINDS, and bump it if the kind landed later.
 */
export const OMP_MIN_CLIENT = "0.45.0";
