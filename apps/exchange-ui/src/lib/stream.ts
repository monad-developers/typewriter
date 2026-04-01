"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BucketSize, Candle, MarketSnapshot } from "./types";

const POLL_INTERVAL = 1_000;

export function useMarketStream(instrument: string, bucket: BucketSize) {
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    let timeoutId: ReturnType<typeof setTimeout>;

    async function poll() {
      if (controller.signal.aborted) return;

      try {
        const res = await fetch(
          `/api/market?instrument=${encodeURIComponent(instrument)}&bucket=${bucket}`,
          { signal: controller.signal }
        );
        if (!res.ok || controller.signal.aborted) return;

        const snapshot: MarketSnapshot = await res.json();

        queryClient.setQueryData(["orderbook", instrument], snapshot.orderbook);
        queryClient.setQueryData(["trades", instrument], snapshot.trades);
        queryClient.setQueryData(["ticker", instrument], snapshot.ticker);

        // Merge liveCandle directly into the candles cache
        if (snapshot.liveCandle) {
          const live = snapshot.liveCandle;
          queryClient.setQueryData<Candle[]>(
            ["candles", instrument, bucket],
            (old) => {
              if (!old || old.length === 0) return old ?? [];
              const last = old[old.length - 1];
              if (last.time === live.time) {
                // Update the current candle in-place (new array for React)
                const updated = old.slice(0, -1);
                updated.push(live);
                return updated;
              } else if (live.time > last.time) {
                // New candle period — append
                return [...old, live];
              }
              return old;
            }
          );
        }
      } catch {
        // AbortError or network failure — silently skip
      }

      if (!controller.signal.aborted) {
        timeoutId = setTimeout(poll, POLL_INTERVAL);
      }
    }

    poll();

    return () => {
      controller.abort();
      clearTimeout(timeoutId);
      abortRef.current = null;
    };
  }, [instrument, bucket, queryClient]);
}
