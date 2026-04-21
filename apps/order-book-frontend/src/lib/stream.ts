"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { orderBookOptions, tradesOptions } from "./queries";

const POLL_INTERVAL = 2_000;

export function useMarketStream(instrument: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const controller = new AbortController();

    async function poll() {
      if (controller.signal.aborted) return;

      try {
        await Promise.all([
          queryClient.refetchQueries({
            ...orderBookOptions(instrument),
            exact: true,
          }),
          queryClient.refetchQueries({
            ...tradesOptions(instrument),
            exact: true,
          }),
          queryClient.refetchQueries({
            queryKey: ["candles", instrument],
          }),
        ]);
      } catch {
        // network error — silently skip
      }

      if (!controller.signal.aborted) {
        setTimeout(poll, POLL_INTERVAL);
      }
    }

    // Start polling after initial render settles
    const id = setTimeout(poll, POLL_INTERVAL);

    return () => {
      controller.abort();
      clearTimeout(id);
    };
  }, [instrument, queryClient]);
}
