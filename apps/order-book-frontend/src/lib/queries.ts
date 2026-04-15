import { queryOptions } from "@tanstack/react-query";
import { q32ToPrice, fromLots, TokenAmount } from "order-book-sdk";
import type { Instrument, OrderBook, OrderBookLevel, Trade, Candle, BucketSize } from "./types";
import { API_URL, tokenName, instrumentConfig } from "./constants";

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
        baseAddress: i.base.toLowerCase(),
        quoteAddress: i.quote.toLowerCase(),
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
      const data = await res.json();
      const inst = instrumentConfig(Number(instrument));

      const convertLevel = (level: {
        price: string;
        size: string;
        total: string;
      }): OrderBookLevel => ({
        price: q32ToPrice(BigInt(level.price), inst),
        size: TokenAmount.fromRaw(
          fromLots(BigInt(level.size), inst.baseLotExp),
          inst.base,
        ).human,
        total: TokenAmount.fromRaw(
          fromLots(BigInt(level.total), inst.baseLotExp),
          inst.base,
        ).human,
      });

      return {
        instrument: data.instrument,
        bids: data.bids.map(convertLevel),
        asks: data.asks.map(convertLevel),
        lastPrice: q32ToPrice(BigInt(data.lastPrice), inst),
        spread: q32ToPrice(BigInt(data.spread), inst),
      };
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
      const inst = instrumentConfig(Number(instrument));

      return data.trades.map(
        (t: {
          id: string;
          price: string;
          size: string;
          side: "buy" | "sell";
          timestamp: number;
        }) => ({
          id: t.id,
          price: q32ToPrice(BigInt(t.price), inst),
          size: TokenAmount.fromRaw(
            fromLots(BigInt(t.size), inst.baseLotExp),
            inst.base,
          ).human,
          side: t.side,
          timestamp: t.timestamp,
        }),
      );
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
      const inst = instrumentConfig(Number(instrument));

      return data.candles.map(
        (c: {
          time: number;
          open: string;
          high: string;
          low: string;
          close: string;
          volume: string;
        }) => ({
          time: c.time,
          open: q32ToPrice(BigInt(c.open), inst),
          high: q32ToPrice(BigInt(c.high), inst),
          low: q32ToPrice(BigInt(c.low), inst),
          close: q32ToPrice(BigInt(c.close), inst),
          volume: TokenAmount.fromRaw(
            fromLots(BigInt(c.volume), inst.baseLotExp),
            inst.base,
          ).human,
        }),
      );
    },
  });
}
