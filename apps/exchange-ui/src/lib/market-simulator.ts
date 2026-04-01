import type {
  Instrument,
  OrderBook,
  OrderBookLevel,
  Trade,
  Ticker,
  Candle,
  MarketSnapshot,
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
  return base >= 10 ? 2 : 4;
}

interface InstrumentState {
  currentPrice: number;
  orderbook: OrderBook;
  trades: Trade[];
  candles: Candle[];
  ticker: Ticker;
  lastAdvanceAt: number;
  lastPollAt: number;
  tradeCounter: number;
}

function initState(instrument: string): InstrumentState {
  const basePrice = getBasePrice(instrument);
  const decimals = getPriceDecimals(instrument);
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const hourSeconds = 3600;

  // Seeded RNG for deterministic initial history
  const rand = seededRandom(instrument.length * 3000 + 7);

  // Generate initial candle history (120 hourly candles)
  let price = basePrice * (0.98 + rand() * 0.04);
  const candles: Candle[] = [];
  for (let i = 0; i < 120; i++) {
    const time = nowSec - (120 - i) * hourSeconds;
    const open = price;
    const volatility = basePrice * 0.003;
    const move1 = (rand() - 0.5) * volatility * 2;
    const move2 = (rand() - 0.5) * volatility * 2;
    const move3 = (rand() - 0.5) * volatility * 2;
    const close = open + move1 + move2 * 0.5;
    const high = Math.max(open, close) + Math.abs(move3);
    const low =
      Math.min(open, close) - Math.abs((rand() - 0.5) * volatility);
    candles.push({
      time,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
    });
    price = close;
  }

  const currentPrice = Number(price.toFixed(decimals));

  // Generate initial trades (seeded for deterministic history)
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

  // Orderbook uses seeded RNG for deterministic initial state
  const bookRand = seededRandom(instrument.length * 1000 + 42);
  const orderbook = buildOrderbook(instrument, currentPrice, decimals, bookRand);
  const ticker = buildTicker(instrument, currentPrice, candles);

  return {
    currentPrice,
    orderbook,
    trades,
    candles,
    ticker,
    lastAdvanceAt: now,
    lastPollAt: now,
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
  candles: Candle[]
): Ticker {
  const recent = candles.slice(-24);
  let high24h = -Infinity;
  let low24h = Infinity;
  let volume24h = 0;
  for (const c of recent) {
    high24h = Math.max(high24h, c.high);
    low24h = Math.min(low24h, c.low);
    volume24h += 10 + Math.random() * 50;
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

  // Update current candle or start new one
  const nowSec = Math.floor(now / 1000);
  const lastCandle = state.candles[state.candles.length - 1];
  const currentHour = Math.floor(nowSec / 3600) * 3600;

  if (lastCandle && lastCandle.time === currentHour) {
    lastCandle.close = state.currentPrice;
    lastCandle.high = Number(
      Math.max(lastCandle.high, state.currentPrice).toFixed(2)
    );
    lastCandle.low = Number(
      Math.min(lastCandle.low, state.currentPrice).toFixed(2)
    );
  } else {
    state.candles.push({
      time: currentHour,
      open: state.currentPrice,
      high: state.currentPrice,
      low: state.currentPrice,
      close: state.currentPrice,
    });
    if (state.candles.length > 120) {
      state.candles = state.candles.slice(-120);
    }
  }

  // Rebuild orderbook around new price
  state.orderbook = buildOrderbook(instrument, state.currentPrice, decimals);

  // Rebuild ticker
  state.ticker = buildTicker(instrument, state.currentPrice, state.candles);
}

class MarketSimulator {
  private states = new Map<string, InstrumentState>();

  private getState(instrument: string): InstrumentState {
    let state = this.states.get(instrument);
    if (!state) {
      state = initState(instrument);
      this.states.set(instrument, state);
    }
    return state;
  }

  getSnapshot(instrument: string): MarketSnapshot {
    const state = this.getState(instrument);
    const now = Date.now();

    // Lazy time advancement: catch up on missed ticks (500ms each, cap at 20)
    const elapsed = now - state.lastAdvanceAt;
    const ticksToRun = Math.min(Math.floor(elapsed / 500), 20);
    for (let i = 0; i < ticksToRun; i++) {
      advanceTick(instrument, state);
    }
    if (ticksToRun > 0) {
      state.lastAdvanceAt = now;
    }

    const snapshot: MarketSnapshot = {
      instrument,
      ts: now,
      orderbook: state.orderbook,
      trades: state.trades,
      ticker: state.ticker,
      candles: state.candles,
    };

    state.lastPollAt = now;
    return snapshot;
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
