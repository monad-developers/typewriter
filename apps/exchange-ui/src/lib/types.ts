export interface Instrument {
  id: string;
  base: string;
  quote: string;
  displayName: string;
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
  instrument: string;
  price: number;
  size: number;
  side: "buy" | "sell";
  timestamp: number;
}

export interface Ticker {
  instrument: string;
  lastPrice: number;
  change24h: number;
  changePercent24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MarketSnapshot {
  instrument: string;
  ts: number;
  orderbook: OrderBook;
  trades: Trade[];
  ticker: Ticker;
  candles: Candle[];
}
