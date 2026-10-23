import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { qk } from "../api/qk";
import type { AgentsData, MachinesData } from "../api/queries";
import { connectBusEvents } from "./busEvents";

/** At most one refetch of both lists per this window, on the trailing edge. */
const REFETCH_WINDOW_MS = 1_000;

export type LiveStatus = "connecting" | "live" | "paused";

/**
 * Keeps the machines and agents caches current from /api/v1/events.
 * `status` is "connecting" until the first hello, "live" after a hello, and
 * "paused" while the stream is down (until the next hello). The data on screen
 * stays either way (the initial GET is the source of truth on every mount).
 * Snapshots are server data, so they go straight into the cache; pending
 * revokes are overlaid by `useMachines` on read.
 */
export function useBusEvents() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");

  useEffect(() => {
    let disposed = false;
    let refetchTimer: ReturnType<typeof setTimeout> | undefined;
    setStatus("connecting");

    const refetchNow = () => {
      clearTimeout(refetchTimer);
      refetchTimer = undefined;
      void qc.invalidateQueries({ queryKey: qk.machines });
      void qc.invalidateQueries({ queryKey: qk.agents });
    };
    // Unknown frames can arrive in bursts: coalesce them into one refetch.
    const refetchSoon = () => {
      if (refetchTimer) return;
      refetchTimer = setTimeout(refetchNow, REFETCH_WINDOW_MS);
    };
    // setQueryData doesn't stop a running fetch, and an older GET resolving
    // later would overwrite this newer snapshot. Cancel first (and wait for the
    // cancel to settle, or its revert would wipe the data we are about to write).
    const write = <T>(key: readonly string[], data: T) => {
      void qc.cancelQueries({ queryKey: key, exact: true }).then(() => {
        if (!disposed) qc.setQueryData<T>(key, data);
      });
    };

    const events = connectBusEvents({
      onHello: () => {
        setStatus("live");
        refetchNow();
      },
      onSnapshot: (s) => {
        setStatus("live");
        if ("machines" in s)
          write<MachinesData>(qk.machines, { machines: s.machines });
        else write<AgentsData>(qk.agents, { agents: s.agents });
      },
      onDown: () => setStatus("paused"),
      onUnknown: refetchSoon,
    });
    const onFocus = () => {
      if (!document.hidden) events.retry();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      disposed = true;
      clearTimeout(refetchTimer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      events.close();
      setStatus("paused");
    };
  }, [qc]);

  return { status, live: status === "live" };
}
