import { z } from "zod";
import { LIMITS } from "./limits.js";

/**
 * The daemon's local, stable handle for one harness session: a Claude
 * `sessionId`, an OpenCode root `ses_…`, a Pi session id. Opaque to the hub.
 */
export const AgentRefSchema = z
  .string()
  .min(1)
  .max(LIMITS.maxAgentRefChars)
  .refine((s) => /^[\x21-\x7e]+$/.test(s), "invalid agent ref");
