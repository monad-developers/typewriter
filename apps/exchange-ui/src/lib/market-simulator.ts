import type {
  Instrument,
  OrderBook,
  OrderBookLevel,
  Trade,
  Ticker,
  Candle,
  MarketSnapshot,
  BucketSize,
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

const BUCKET_SECONDS: Record<BucketSize, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
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
  return base >= 10 ? 2 : 4;
}

// --- Candle aggregation ---

export function aggregateCandles(
  candles1m: Candle[],
  bucket: BucketSize
): Candle[] {
  if (bucket === "1m") return candles1m;

  const seconds = BUCKET_SECONDS[bucket];
  const buckets = new Map<number, Candle>();

  for (const c of candles1m) {
    const key = Math.floor(c.time / seconds) * seconds;
    const existing = buckets.get(key);
    if (existing) {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume = Number((existing.volume + c.volume).toFixed(3));
    } else {
      buckets.set(key, {
        time: key,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    }
  }

  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

// --- State ---

interface InstrumentState {
  currentPrice: number;
  orderbook: OrderBook;
  trades: Trade[];
  candles1m: Candle[];
  ticker: Ticker;
  lastAdvanceAt: number;
  tradeCounter: number;
}

function initState(instrument: string): InstrumentState {
  const basePrice = getBasePrice(instrument);
  const decimals = getPriceDecimals(instrument);
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);

  const rand = seededRandom(instrument.length * 3000 + 7);

  // Generate 10,000 one-minute candles (~7 days of history)
  const totalCandles = 10000;
  let price = basePrice * (0.98 + rand() * 0.04);
  const candles1m: Candle[] = [];
  for (let i = 0; i < totalCandles; i++) {
    const time = Math.floor((nowSec - (totalCandles - i) * 60) / 60) * 60;
    const open = price;
    const volatility = basePrice * 0.0008;
    const move1 = (rand() - 0.5) * volatility * 2;
    const move2 = (rand() - 0.5) * volatility * 2;
    const move3 = (rand() - 0.5) * volatility * 2;
    const close = open + move1 + move2 * 0.5;
    const high = Math.max(open, close) + Math.abs(move3);
    const low =
      Math.min(open, close) - Math.abs((rand() - 0.5) * volatility);
    const volume = Number((0.5 + rand() * 10).toFixed(3));
    candles1m.push({
      time,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume,
    });
    price = close;
  }

  const currentPrice = Number(price.toFixed(decimals));

  // Generate initial trades
  const tradeRand = seededRandom(instrument.length * 2000 + 99);
  const trades: Trade[] = [];
  let tradePrice = currentPrice;
  for (let i = 0; i < 200; i++) {
    const drift = (tradeRand() - 0.5) * basePrice * 0.001;
    tradePrice = Math.max(
      basePrice * 0.95,
      Math.min(basePrice * 1.05, tradePrice + drift)
    );
    trades.push({
      id: `t-${instrument}-init-${i}`,
      instrument,
      price: Number(tradePrice.toFixed(decimals)),
      size: Number((0.1 + tradeRand() * 5).toFixed(3)),
      side: tradeRand() > 0.5 ? "buy" : "sell",
      timestamp: now - (200 - i) * 5 * 60 * 1000,
    });
  }

  const bookRand = seededRandom(instrument.length * 1000 + 42);
  const orderbook = buildOrderbook(instrument, currentPrice, decimals, bookRand);
  const ticker = buildTicker(instrument, currentPrice, candles1m);

  return {
    currentPrice,
    orderbook,
    trades,
    candles1m,
    ticker,
    lastAdvanceAt: now,
    tradeCounter: 200,
  };
}

function buildOrderbook(
  instrument: string,
  midPrice: number,
  decimals: number,
  rand: () => number = Math.random
): OrderBook {
  const basePrice = getBasePrice(instrument);
  const tickSize = basePrice >= 100 ? 0.1 : 0.01;
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

function buildTicker(
  instrument: string,
  currentPrice: number,
  candles1m: Candle[]
): Ticker {
  // Use last 1440 minutes (24h) of 1m candles
  const recent = candles1m.slice(-1440);
  let high24h = -Infinity;
  let low24h = Infinity;
  let volume24h = 0;
  for (const c of recent) {
    high24h = Math.max(high24h, c.high);
    low24h = Math.min(low24h, c.low);
    volume24h += c.volume;
  }
  const firstPrice = recent[0]?.open ?? currentPrice;
  const change24h = currentPrice - firstPrice;
  const changePercent24h = (change24h / firstPrice) * 100;

  return {
    instrument,
    lastPrice: Number(currentPrice.toFixed(2)),
    change24h: Number(change24h.toFixed(2)),
    changePercent24h: Number(changePercent24h.toFixed(2)),
    high24h: Number(high24h.toFixed(2)),
    low24h: Number(low24h.toFixed(2)),
    volume24h: Number(volume24h.toFixed(2)),
  };
}

function advanceTick(instrument: string, state: InstrumentState): void {
  const basePrice = getBasePrice(instrument);
  const decimals = getPriceDecimals(instrument);

  // Brownian price drift
  const volatility = basePrice * 0.0005;
  const drift = (Math.random() - 0.5) * volatility * 2;
  state.currentPrice = Number(
    Math.max(
      basePrice * 0.9,
      Math.min(basePrice * 1.1, state.currentPrice + drift)
    ).toFixed(decimals)
  );

  // Generate 0-2 new trades
  const numTrades = Math.floor(Math.random() * 3);
  const now = Date.now();
  for (let i = 0; i < numTrades; i++) {
    const tradeDrift = (Math.random() - 0.5) * basePrice * 0.0003;
    const tradePrice = Number(
      (state.currentPrice + tradeDrift).toFixed(decimals)
    );
    state.trades.push({
      id: `t-${instrument}-${state.tradeCounter++}`,
      instrument,
      price: tradePrice,
      size: Number((0.1 + Math.random() * 5).toFixed(3)),
      side: Math.random() > 0.5 ? "buy" : "sell",
      timestamp: now,
    });
  }

  // Cap trades at 200
  if (state.trades.length > 200) {
    state.trades = state.trades.slice(-200);
  }

  // Update current 1-minute candle or start new one
  const nowSec = Math.floor(now / 1000);
  const currentMinute = Math.floor(nowSec / 60) * 60;
  const lastCandle = state.candles1m[state.candles1m.length - 1];

  if (lastCandle && lastCandle.time === currentMinute) {
    lastCandle.close = state.currentPrice;
    lastCandle.high = Number(
      Math.max(lastCandle.high, state.currentPrice).toFixed(2)
    );
    lastCandle.low = Number(
      Math.min(lastCandle.low, state.currentPrice).toFixed(2)
    );
    lastCandle.volume = Number(
      (lastCandle.volume + numTrades * (0.1 + Math.random() * 2)).toFixed(3)
    );
  } else {
    state.candles1m.push({
      time: currentMinute,
      open: state.currentPrice,
      high: state.currentPrice,
      low: state.currentPrice,
      close: state.currentPrice,
      volume: Number((numTrades * (0.1 + Math.random() * 2)).toFixed(3)),
    });
    if (state.candles1m.length > 10000) {
      state.candles1m = state.candles1m.slice(-10000);
    }
  }

  // Rebuild orderbook around new price
  state.orderbook = buildOrderbook(instrument, state.currentPrice, decimals);

  // Rebuild ticker
  state.ticker = buildTicker(instrument, state.currentPrice, state.candles1m);
}

class MarketSimulator {
  private states = new Map<string, InstrumentState>();

  private getOrAdvance(instrument: string): InstrumentState {
    let state = this.states.get(instrument);
    if (!state) {
      state = initState(instrument);
      this.states.set(instrument, state);
    }

    const now = Date.now();
    const elapsed = now - state.lastAdvanceAt;
    const ticksToRun = Math.min(Math.floor(elapsed / 500), 20);
    for (let i = 0; i < ticksToRun; i++) {
      advanceTick(instrument, state);
    }
    if (ticksToRun > 0) {
      state.lastAdvanceAt = now;
    }

    return state;
  }

  getSnapshot(instrument: string, bucket?: BucketSize): MarketSnapshot {
    const state = this.getOrAdvance(instrument);
    let liveCandle: Candle | null = null;
    if (bucket) {
      const aggregated = aggregateCandles(state.candles1m, bucket);
      liveCandle = aggregated[aggregated.length - 1] ?? null;
    }
    return {
      instrument,
      ts: Date.now(),
      orderbook: state.orderbook,
      trades: state.trades,
      ticker: state.ticker,
      liveCandle,
    };
  }

  getCandles(
    instrument: string,
    bucket: BucketSize,
    before?: number,
    count: number = 200
  ): { candles: Candle[]; hasMore: boolean } {
    const state = this.getOrAdvance(instrument);
    const aggregated = aggregateCandles(state.candles1m, bucket);

    let filtered: Candle[];
    if (before != null) {
      filtered = aggregated.filter((c) => c.time < before);
    } else {
      filtered = aggregated;
    }

    const hasMore = filtered.length > count;
    const result = filtered.slice(-count);
    return { candles: result, hasMore };
  }
}

// Singleton that survives HMR
const globalKey = "__marketSim" as const;

declare const globalThis: { [globalKey]?: MarketSimulator };

export function getSimulator(): MarketSimulator {
  if (!globalThis[globalKey]) {
    globalThis[globalKey] = new MarketSimulator();
  }
  return globalThis[globalKey];
}
