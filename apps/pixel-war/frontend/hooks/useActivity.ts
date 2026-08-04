import { useEffect, useState } from "react";
import type { Hex } from "viem";

export type ActivityEvent = {
  id: number;
  name: string;
  status: string;
  account: Hex | null;
  x: number | null;
  y: number | null;
  color: number | null;
  isForceInclusion: boolean;
};

const FEED_LIMIT = 18;

/// Keeps one row per mutation id, showing the latest lifecycle status the server
/// has reported for it: accepted, then included, safe, finalized.
export function useActivity(): { events: ActivityEvent[]; dropped: number } {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [dropped, setDropped] = useState(0);

  useEffect(() => {
    const source = new EventSource("/api/events/activity");
    source.addEventListener("activity", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        events: ActivityEvent[];
        dropped: number;
      };
      if (payload.dropped > 0) {
        setDropped((value) => value + payload.dropped);
      }
      setEvents((current) => {
        const byId = new Map(current.map((entry) => [entry.id, entry]));
        for (const entry of payload.events) byId.set(entry.id, entry);
        return [...byId.values()]
          .sort((a, b) => b.id - a.id)
          .slice(0, FEED_LIMIT);
      });
    });
    return () => source.close();
  }, []);

  return { events, dropped };
}
