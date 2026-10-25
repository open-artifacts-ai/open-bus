import { z } from "zod";

export const AGENT_KINDS = ["claude-code", "opencode", "pi", "omp"] as const;
export const AgentKindSchema = z.enum(AGENT_KINDS);
export type AgentKind = z.infer<typeof AgentKindSchema>;

/**
 * The shape of any agent kind, known or not yet. What a reader accepts where
 * the hub or daemon reports a kind (roster rows, from 0.45.0), so a new kind
 * needs no version gate for those readers. Writers (`agent_up`, `hello`)
 * stay on AgentKindSchema.
 */
export const KindTokenSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

/** A kind for display: a known kind, else `other`. */
export type DisplayKind = AgentKind | "other";
export const displayKind = (kind: string): DisplayKind =>
  (AGENT_KINDS as readonly string[]).includes(kind)
    ? (kind as AgentKind)
    : "other";

/**
 * The first client version whose roster decoder accepts the `omp` kind. The
 * hub omits omp roster rows for daemons below it (CONTRACT.md, version
 * gating). Predicted, not observed: verify it against the release tag that
 * first ships `omp` in AGENT_KINDS, and bump it if the kind landed later.
 */
export const OMP_MIN_CLIENT = "0.45.0";
