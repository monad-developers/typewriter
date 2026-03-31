import type {
  Instrument,
  OrderBook,
  OrderBookLevel,
  Trade,
  Ticker,
  Candle,
} from "./types";

export const INSTRUMENTS: Instrument[] = [
  { id: "GOLD-USDC", base: "GOLD", quote: "USDC", displayName: "GOLD/USDC" },
  {
    id: "WTIOIL-USDC",
    base: "WTIOIL",
    quote: "USDC",
    displayName: "WTIOIL/USDC",
  },
  {
    id: "SILVER-USDC",
    base: "SILVER",
    quote: "USDC",
    displayName: "SILVER/USDC",
  },
];

const BASE_PRICES: Record<string, number> = {
  "GOLD-USDC": 2650,
  "WTIOIL-USDC": 78,
  "SILVER-USDC": 31,
};

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function getBasePrice(instrument: string): number {
  return BASE_PRICES[instrument] ?? 100;
}

function getPriceDecimals(instrument: string): number {
  const base = getBasePrice(instrument);
  if (base >= 1000) return 2;
  if (base >= 10) return 2;
  return 4;
}

export function generateOrderBook(instrument: string): OrderBook {
  const basePrice = getBasePrice(instrument);
  const decimals = getPriceDecimals(instrument);
  const rand = seededRandom(instrument.length * 1000 + 42);
  const tickSize = basePrice >= 100 ? 0.1 : 0.01;

  const midPrice = basePrice * (1 + (rand() - 0.5) * 0.002);
  const spreadTicks = 1 + Math.floor(rand() * 3);
  const spread = spreadTicks * tickSize;

  const bestBid = midPrice - spread / 2;
  const bestAsk = midPrice + spread / 2;

  const bids: OrderBookLevel[] = [];
  let bidTotal = 0;
  for (let i = 0; i < 15; i++) {
    const price = Number((bestBid - i * tickSize).toFixed(decimals));
    const size = Number((0.5 + rand() * 10).toFixed(3));
    bidTotal += size;
    bids.push({ price, size, total: Number(bidTotal.toFixed(3)) });
  }

  const asks: OrderBookLevel[] = [];
  let askTotal = 0;
  for (let i = 0; i < 15; i++) {
    const price = Number((bestAsk + i * tickSize).toFixed(decimals));
    const size = Number((0.5 + rand() * 10).toFixed(3));
    askTotal += size;
    asks.push({ price, size, total: Number(askTotal.toFixed(3)) });
  }

  return {
    instrument,
    bids,
    asks,
    lastPrice: Number(midPrice.toFixed(decimals)),
    spread: Number(spread.toFixed(decimals)),
  };
}

export function generateTrades(instrument: string): Trade[] {
  const basePrice = getBasePrice(instrument);
  const decimals = getPriceDecimals(instrument);
  const rand = seededRandom(instrument.length * 2000 + 99);
  const now = Date.now();
  const trades: Trade[] = [];

  let price = basePrice;
  for (let i = 0; i < 200; i++) {
    const drift = (rand() - 0.5) * basePrice * 0.001;
    price = Math.max(basePrice * 0.95, Math.min(basePrice * 1.05, price + drift));
    const side = rand() > 0.5 ? "buy" : "sell" as const;
    trades.push({
      id: `t-${instrument}-${i}`,
      instrument,
      price: Number(price.toFixed(decimals)),
      size: Number((0.1 + rand() * 5).toFixed(3)),
      side,
      timestamp: now - (200 - i) * 5 * 60 * 1000,
    });
  }

  return trades;
}

export function generateCandles(instrument: string): Candle[] {
  const basePrice = getBasePrice(instrument);
  const rand = seededRandom(instrument.length * 3000 + 7);
  const now = Math.floor(Date.now() / 1000);
  const hourSeconds = 3600;
  const candles: Candle[] = [];

  let price = basePrice * (0.98 + rand() * 0.04);
  for (let i = 0; i < 120; i++) {
    const time = now - (120 - i) * hourSeconds;
    const open = price;
    const volatility = basePrice * 0.003;
    const move1 = (rand() - 0.5) * volatility * 2;
    const move2 = (rand() - 0.5) * volatility * 2;
    const move3 = (rand() - 0.5) * volatility * 2;
    const close = open + move1 + move2 * 0.5;
    const high = Math.max(open, close) + Math.abs(move3);
    const low = Math.min(open, close) - Math.abs((rand() - 0.5) * volatility);

    candles.push({
      time,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
    });
    price = close;
  }

  return candles;
}

export function generateTicker(instrument: string): Ticker {
  const candles = generateCandles(instrument);
  const lastCandle = candles[candles.length - 1];
  const firstCandle = candles[0];
  const lastPrice = lastCandle.close;
  const change24h = lastPrice - firstCandle.open;
  const changePercent24h = (change24h / firstCandle.open) * 100;

  let high24h = -Infinity;
  let low24h = Infinity;
  let volume24h = 0;
  const rand = seededRandom(instrument.length * 4000 + 13);

  for (const c of candles.slice(-24)) {
    high24h = Math.max(high24h, c.high);
    low24h = Math.min(low24h, c.low);
    volume24h += 10 + rand() * 50;
  }

  return {
    instrument,
    lastPrice: Number(lastPrice.toFixed(2)),
    change24h: Number(change24h.toFixed(2)),
    changePercent24h: Number(changePercent24h.toFixed(2)),
    high24h: Number(high24h.toFixed(2)),
    low24h: Number(low24h.toFixed(2)),
    volume24h: Number(volume24h.toFixed(2)),
  };
}
