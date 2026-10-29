import { z } from "zod";

export const AGENT_KINDS = [
  "claude-code",
  "opencode",
  "pi",
  "omp",
  "codex",
] as const;
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
 * The only kinds a daemon below KIND_TOKEN_MIN_CLIENT decodes (its closed
 * enum, v0.44.x). Frozen: never add to it.
 */
export const PRE_TOKEN_KINDS = ["claude-code", "opencode", "pi"] as const;

/**
 * The first client version whose roster decoder accepts any kind token
 * (KindTokenSchema). The hub sends daemons below it only PRE_TOKEN_KINDS rows
 * (CONTRACT.md, version gating). Predicted, not observed: verify it against
 * the release tag that first ships KindTokenSchema and `omp`, and bump it if
 * they landed in a later release.
 */
export const KIND_TOKEN_MIN_CLIENT = "0.45.0";
