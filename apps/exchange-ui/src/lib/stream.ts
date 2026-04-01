"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BucketSize, MarketSnapshot } from "./types";

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
        queryClient.setQueryData(
          ["liveCandle", instrument, bucket],
          snapshot.liveCandle
        );
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
