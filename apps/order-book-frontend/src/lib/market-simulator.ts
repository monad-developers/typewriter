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

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

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
  restingBids: Map<number, number>; // price -> total size
  restingAsks: Map<number, number>; // price -> total size
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

  const rand = seededRandom(hashString(instrument) * 3 + 7);

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
  const tradeRand = seededRandom(hashString(instrument) * 2 + 99);
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

  // Initialize resting order book with seeded randomness
  const bookRand = seededRandom(hashString(instrument) + 42);
  const tickSize = getTickSize(instrument);
  const restingBids = new Map<number, number>();
  const restingAsks = new Map<number, number>();

  const spreadTicks = 1 + Math.floor(bookRand() * 3);
  const spread = spreadTicks * tickSize;
  const bestBid = Number((currentPrice - spread / 2).toFixed(decimals));
  const bestAsk = Number((currentPrice + spread / 2).toFixed(decimals));

  for (let i = 0; i < 15; i++) {
    const bidPrice = Number((bestBid - i * tickSize).toFixed(decimals));
    const askPrice = Number((bestAsk + i * tickSize).toFixed(decimals));
    restingBids.set(bidPrice, Number((0.5 + bookRand() * 10).toFixed(3)));
    restingAsks.set(askPrice, Number((0.5 + bookRand() * 10).toFixed(3)));
  }

  const orderbook = buildOrderbookFromResting(instrument, restingBids, restingAsks, currentPrice, decimals);
  const ticker = buildTicker(instrument, currentPrice, candles1m);

  return {
    currentPrice,
    restingBids,
    restingAsks,
    orderbook,
    trades,
    candles1m,
    ticker,
    lastAdvanceAt: now,
    tradeCounter: 200,
  };
}

function getTickSize(instrument: string): number {
  const basePrice = getBasePrice(instrument);
  return basePrice >= 100 ? 0.1 : 0.01;
}

/** Build the OrderBook view from resting bid/ask maps */
function buildOrderbookFromResting(
  instrument: string,
  restingBids: Map<number, number>,
  restingAsks: Map<number, number>,
  lastPrice: number,
  decimals: number
): OrderBook {
  // Sort bids descending (best bid first)
  const sortedBids = [...restingBids.entries()]
    .filter(([, size]) => size > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 15);

  // Sort asks ascending (best ask first)
  const sortedAsks = [...restingAsks.entries()]
    .filter(([, size]) => size > 0)
    .sort((a, b) => a[0] - b[0])
    .slice(0, 15);

  const bids: OrderBookLevel[] = [];
  let bidTotal = 0;
  for (const [price, size] of sortedBids) {
    bidTotal += size;
    bids.push({ price, size: Number(size.toFixed(3)), total: Number(bidTotal.toFixed(3)) });
  }

  const asks: OrderBookLevel[] = [];
  let askTotal = 0;
  for (const [price, size] of sortedAsks) {
    askTotal += size;
    asks.push({ price, size: Number(size.toFixed(3)), total: Number(askTotal.toFixed(3)) });
  }

  const bestBid = sortedBids[0]?.[0] ?? lastPrice;
  const bestAsk = sortedAsks[0]?.[0] ?? lastPrice;
  const spread = Number((bestAsk - bestBid).toFixed(decimals));

  return {
    instrument,
    bids,
    asks,
    lastPrice: Number(lastPrice.toFixed(decimals)),
    spread: Math.max(0, spread),
  };
}

/**
 * Match an incoming order against the resting book.
 * Returns fills as trades and any remaining unfilled size.
 */
function matchOrder(
  side: "buy" | "sell",
  size: number,
  restingBids: Map<number, number>,
  restingAsks: Map<number, number>,
  instrument: string,
  decimals: number,
  tradeCounter: { value: number },
  timestamp: number
): { trades: Trade[]; remaining: number } {
  const trades: Trade[] = [];
  let remaining = size;

  // A buy order matches against asks (ascending price); a sell matches against bids (descending price)
  const book = side === "buy" ? restingAsks : restingBids;
  const prices = [...book.keys()].sort((a, b) =>
    side === "buy" ? a - b : b - a
  );

  for (const price of prices) {
    if (remaining <= 0.001) break;
    const available = book.get(price)!;
    const fillSize = Math.min(remaining, available);
    const newAvailable = Number((available - fillSize).toFixed(3));

    if (newAvailable <= 0.001) {
      book.delete(price);
    } else {
      book.set(price, newAvailable);
    }

    remaining = Number((remaining - fillSize).toFixed(3));
    trades.push({
      id: `t-${instrument}-${tradeCounter.value++}`,
      instrument,
      price,
      size: Number(fillSize.toFixed(3)),
      side,
      timestamp,
    });
  }

  return { trades, remaining };
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
  const tickSize = getTickSize(instrument);
  const now = Date.now();
  const tradeCounter = { value: state.tradeCounter };
  let tradeVolume = 0;

  // --- 1. Random cancellations biased toward near-spread levels ---
  const numCancels = Math.floor(Math.random() * 3);
  for (let i = 0; i < numCancels; i++) {
    const isBidSide = Math.random() > 0.5;
    const book = isBidSide ? state.restingBids : state.restingAsks;
    const keys = [...book.keys()].sort((a, b) =>
      isBidSide ? b - a : a - b  // best price first
    );
    if (keys.length === 0) continue;
    // Exponential bias: ~63% chance in top 3 levels, rarely touches deep levels
    const idx = Math.min(Math.floor(-Math.log(1 - Math.random()) * 2), keys.length - 1);
    const key = keys[idx];
    const current = book.get(key)!;
    const cancelAmt = Number((Math.random() * current * 0.3).toFixed(3));
    const newSize = Number((current - cancelAmt).toFixed(3));
    if (newSize <= 0.05) {
      book.delete(key);
    } else {
      book.set(key, newSize);
    }
  }

  // --- 2. Add new limit orders (1-3 per tick) biased near the spread ---
  const numNewLimits = 1 + Math.floor(Math.random() * 3);
  const bestBid = Math.max(...(state.restingBids.size ? state.restingBids.keys() : [state.currentPrice - tickSize]));
  const bestAsk = Math.min(...(state.restingAsks.size ? state.restingAsks.keys() : [state.currentPrice + tickSize]));

  for (let i = 0; i < numNewLimits; i++) {
    const isBid = Math.random() > 0.5;
    // Exponential depth: most orders land in top 3 levels, rarely beyond 6-7
    const depth = Math.min(Math.floor(-Math.log(1 - Math.random()) * 2), 14);
    const size = Number((0.2 + Math.random() * 3).toFixed(3));

    if (isBid) {
      const price = Number((bestBid - depth * tickSize).toFixed(decimals));
      if (price > basePrice * 0.85) {
        const existing = state.restingBids.get(price) ?? 0;
        state.restingBids.set(price, Number((existing + size).toFixed(3)));
      }
    } else {
      const price = Number((bestAsk + depth * tickSize).toFixed(decimals));
      if (price < basePrice * 1.15) {
        const existing = state.restingAsks.get(price) ?? 0;
        state.restingAsks.set(price, Number((existing + size).toFixed(3)));
      }
    }
  }

  // --- 3. Incoming market orders (0-2 per tick) that match against resting book ---
  const numMarketOrders = Math.floor(Math.random() * 3);
  for (let i = 0; i < numMarketOrders; i++) {
    const side: "buy" | "sell" = Math.random() > 0.5 ? "buy" : "sell";
    const orderSize = Number((0.1 + Math.random() * 3).toFixed(3));

    const { trades: fills } = matchOrder(
      side,
      orderSize,
      state.restingBids,
      state.restingAsks,
      instrument,
      decimals,
      tradeCounter,
      now
    );

    for (const fill of fills) {
      state.trades.push(fill);
      tradeVolume += fill.size;
      // Update current price to last fill price
      state.currentPrice = fill.price;
    }
  }

  state.tradeCounter = tradeCounter.value;

  // --- 4. Clamp price to bounds ---
  state.currentPrice = Number(
    Math.max(basePrice * 0.9, Math.min(basePrice * 1.1, state.currentPrice)).toFixed(decimals)
  );

  // --- 5. Replenish if book is too thin (fewer than 8 levels on either side) ---
  const bidCount = state.restingBids.size;
  const askCount = state.restingAsks.size;
  const currentBestBid = bidCount > 0 ? Math.max(...state.restingBids.keys()) : state.currentPrice - tickSize;
  const currentBestAsk = askCount > 0 ? Math.min(...state.restingAsks.keys()) : state.currentPrice + tickSize;

  if (bidCount < 8) {
    const deepestBid = bidCount > 0 ? Math.min(...state.restingBids.keys()) : currentBestBid;
    for (let i = 0; i < 15 - bidCount; i++) {
      const price = Number((deepestBid - (i + 1) * tickSize).toFixed(decimals));
      if (price > basePrice * 0.85 && !state.restingBids.has(price)) {
        state.restingBids.set(price, Number((0.5 + Math.random() * 6).toFixed(3)));
      }
    }
  }
  if (askCount < 8) {
    const deepestAsk = askCount > 0 ? Math.max(...state.restingAsks.keys()) : currentBestAsk;
    for (let i = 0; i < 15 - askCount; i++) {
      const price = Number((deepestAsk + (i + 1) * tickSize).toFixed(decimals));
      if (price < basePrice * 1.15 && !state.restingAsks.has(price)) {
        state.restingAsks.set(price, Number((0.5 + Math.random() * 6).toFixed(3)));
      }
    }
  }

  // Cap trades at 200
  if (state.trades.length > 200) {
    state.trades = state.trades.slice(-200);
  }

  // --- 6. Update candles ---
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
      (lastCandle.volume + tradeVolume).toFixed(3)
    );
  } else {
    state.candles1m.push({
      time: currentMinute,
      open: state.currentPrice,
      high: state.currentPrice,
      low: state.currentPrice,
      close: state.currentPrice,
      volume: Number(tradeVolume.toFixed(3)),
    });
    if (state.candles1m.length > 10000) {
      state.candles1m = state.candles1m.slice(-10000);
    }
  }

  // --- 7. Rebuild orderbook view & ticker from resting orders ---
  state.orderbook = buildOrderbookFromResting(
    instrument, state.restingBids, state.restingAsks, state.currentPrice, decimals
  );
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
