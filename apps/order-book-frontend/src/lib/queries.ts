import { queryOptions } from "@tanstack/react-query";
import type { Instrument, OrderBook, Trade, Candle, BucketSize } from "./types";
import { API_URL, tokenName } from "./constants";

export const instrumentsOptions = queryOptions({
  queryKey: ["instruments"],
  queryFn: async (): Promise<Instrument[]> => {
    const res = await fetch(`${API_URL}/api/instruments`);
    if (!res.ok) throw new Error("Failed to fetch instruments");
    const data = await res.json();
    return data.instruments.map(
      (i: {
        id: number;
        base: string;
        quote: string;
        baseLotExp: number;
        quoteLotExp: number;
      }) => ({
        id: String(i.id),
        base: tokenName(i.base),
        quote: tokenName(i.quote),
        displayName: `${tokenName(i.base)}/${tokenName(i.quote)}`,
        baseLotExp: i.baseLotExp,
        quoteLotExp: i.quoteLotExp,
      }),
    );
  },
});

export function orderBookOptions(instrument: string) {
  return queryOptions({
    queryKey: ["orderbook", instrument],
    queryFn: async (): Promise<OrderBook> => {
      const res = await fetch(
        `${API_URL}/api/orderbook?instrumentId=${instrument}`,
      );
      if (!res.ok) throw new Error("Failed to fetch orderbook");
      return res.json();
    },
  });
}

export function tradesOptions(instrument: string) {
  return queryOptions({
    queryKey: ["trades", instrument],
    queryFn: async (): Promise<Trade[]> => {
      const res = await fetch(
        `${API_URL}/api/trades?instrumentId=${instrument}&limit=50`,
      );
      if (!res.ok) throw new Error("Failed to fetch trades");
      const data = await res.json();
      return data.trades;
    },
  });
}

export function candlesOptions(instrument: string, bucket: BucketSize = "5m") {
  return queryOptions({
    queryKey: ["candles", instrument, bucket],
    queryFn: async (): Promise<Candle[]> => {
      const res = await fetch(
        `${API_URL}/api/candles?instrumentId=${instrument}&bucket=${bucket}&count=200`,
      );
      if (!res.ok) throw new Error("Failed to fetch candles");
      const data = await res.json();
      return data.candles;
    },
  });
}
