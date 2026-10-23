import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { qk } from "../api/qk";
import type { AgentsData, MachinesData } from "../api/queries";
import { connectBusEvents } from "./busEvents";

/**
 * Keeps the machines and agents caches current from /api/v1/events.
 * `live` is false while the stream is down: the page shows a chip, the data
 * on screen stays (the initial GET is the source of truth on every mount).
 * Snapshots are server data, so they go straight into the cache; pending
 * revokes are overlaid by `useMachines` on read.
 */
export function useBusEvents() {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);

  useEffect(() => {
    const refetchBoth = () => {
      void qc.invalidateQueries({ queryKey: qk.machines });
      void qc.invalidateQueries({ queryKey: qk.agents });
    };
    const events = connectBusEvents({
      onHello: () => {
        setLive(true);
        refetchBoth();
      },
      onSnapshot: (s) => {
        setLive(true);
        if ("machines" in s)
          qc.setQueryData<MachinesData>(qk.machines, { machines: s.machines });
        else qc.setQueryData<AgentsData>(qk.agents, { agents: s.agents });
      },
      onDown: () => setLive(false),
      onUnknown: refetchBoth,
    });
    const onFocus = () => {
      if (document.visibilityState !== "hidden") events.retry();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      events.close();
      setLive(false);
    };
  }, [qc]);

  return { live };
}
