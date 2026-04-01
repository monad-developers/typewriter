import { queryOptions } from "@tanstack/react-query";
import type { Instrument, OrderBook, Ticker, Candle, Trade, BucketSize } from "./types";

export const instrumentsOptions = queryOptions({
  queryKey: ["instruments"],
  queryFn: async (): Promise<Instrument[]> => {
    const res = await fetch("/api/instruments");
    const data = await res.json();
    return data.instruments;
  },
});

export function tickerOptions(instrument: string) {
  return queryOptions({
    queryKey: ["ticker", instrument],
    queryFn: async (): Promise<Ticker> => {
      const res = await fetch(`/api/ticker?instrument=${instrument}`);
      return res.json();
    },
  });
}

export function orderBookOptions(instrument: string) {
  return queryOptions({
    queryKey: ["orderbook", instrument],
    queryFn: async (): Promise<OrderBook> => {
      const res = await fetch(`/api/orderbook?instrument=${instrument}`);
      return res.json();
    },
  });
}

export function candlesOptions(instrument: string, bucket: BucketSize = "1h") {
  return queryOptions({
    queryKey: ["candles", instrument, bucket],
    queryFn: async (): Promise<Candle[]> => {
      const res = await fetch(
        `/api/candles?instrument=${instrument}&bucket=${bucket}&count=200`
      );
      const data = await res.json();
      return data.candles;
    },
  });
}

export function tradesOptions(instrument: string) {
  return queryOptions({
    queryKey: ["trades", instrument],
    queryFn: async (): Promise<Trade[]> => {
      const res = await fetch(`/api/trades?instrument=${instrument}`);
      const data = await res.json();
      return data.trades;
    },
  });
}
