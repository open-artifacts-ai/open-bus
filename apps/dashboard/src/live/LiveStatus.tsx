import { createContext, type ReactNode, useContext } from "react";
import { type LiveStatus, useBusEvents } from "./useBusEvents";

const LiveStatusContext = createContext<LiveStatus>("connecting");

/**
 * The app's one bus-events stream. AppLayout mounts this once, for a signed-in
 * owner only; pages read the status with `useLiveStatus()` and never open
 * their own stream.
 */
export function LiveStatusProvider({ children }: { children: ReactNode }) {
  const { status } = useBusEvents();
  return (
    <LiveStatusContext.Provider value={status}>
      {children}
    </LiveStatusContext.Provider>
  );
}

/** "connecting" | "live" | "paused", from the shell's stream. */
export const useLiveStatus = () => useContext(LiveStatusContext);
