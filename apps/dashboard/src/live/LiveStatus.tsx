import { createContext, type ReactNode, useContext, useMemo } from "react";
import { type LiveStatus, useBusEvents } from "./useBusEvents";

type LiveDetail = {
  /** Reconnect a parked stream now; true when it did (its hello refetches). */
  retry(): boolean;
  /** When the stream dropped, while it stays down; null otherwise. */
  pausedAt: Date | null;
};

const LiveStatusContext = createContext<LiveStatus>("connecting");
const LiveDetailContext = createContext<LiveDetail>({
  retry: () => false,
  pausedAt: null,
});

/**
 * The app's one bus-events stream. AppLayout mounts this once, for a signed-in
 * owner only; pages read the status with `useLiveStatus()` and never open
 * their own stream.
 */
export function LiveStatusProvider({ children }: { children: ReactNode }) {
  const { status, retry, pausedAt } = useBusEvents();
  const detail = useMemo(() => ({ retry, pausedAt }), [retry, pausedAt]);
  return (
    <LiveDetailContext.Provider value={detail}>
      <LiveStatusContext.Provider value={status}>
        {children}
      </LiveStatusContext.Provider>
    </LiveDetailContext.Provider>
  );
}

/** "connecting" | "live" | "paused", from the shell's stream. */
export const useLiveStatus = () => useContext(LiveStatusContext);

/** Asks the shell's stream to reconnect now, if it is parked. */
export const useLiveRetry = () => useContext(LiveDetailContext).retry;

/** When the shell's stream dropped, while it stays down. */
export const useLivePausedAt = () => useContext(LiveDetailContext).pausedAt;
