import { clock } from "../format";
import { useLivePausedAt, useLiveStatus } from "./LiveStatus";

/**
 * The one pause rule: while the shell's stream is down, every liveness claim
 * on screen is stale. `since` is when it dropped and `asOf` the same as a
 * clock time ("10:42 AM"); both are null while live or connecting.
 */
export function usePaused() {
  const paused = useLiveStatus() === "paused";
  const pausedAt = useLivePausedAt();
  const since = paused ? (pausedAt ?? new Date()) : null;
  return { paused, since, asOf: since ? clock(since) : null };
}
