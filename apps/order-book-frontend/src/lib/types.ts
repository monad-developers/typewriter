export interface Instrument {
  id: string;
  base: string;
  quote: string;
  displayName: string;
  baseLotExp: number;
  quoteLotExp: number;
}

export interface OrderBookLevel {
  price: number;
  size: number;
  total: number;
}

export interface OrderBook {
  instrument: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  lastPrice: number;
  spread: number;
}

export interface Trade {
  id: string;
  price: number;
  size: number;
  side: "buy" | "sell";
  timestamp: number;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type BucketSize = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export const DEFAULT_BUCKET: BucketSize = "5m";
