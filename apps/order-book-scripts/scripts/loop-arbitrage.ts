import { fromLots, priceToQ32, TokenAmount } from "order-book-sdk";
import { INSTRUMENTS } from "../src/constants";
import { createAccount, deposit, fetchState, marketOrder } from "../src/sdk";

const DEFAULT_INTERVAL = 10_000;

const YAHOO_SYMBOLS = {
  "GOLD/USD": "GC=F",
  "WTIOIL/USD": "CL=F",
} as const;

if (!process.env.INSTRUMENT) {
  console.error(
    "INSTRUMENT env var is required (e.g. GOLD/USD, or see constants.ts for options)",
  );
  process.exit(1);
}

const instrumentName = process.env.INSTRUMENT as keyof typeof INSTRUMENTS;
const instrument = INSTRUMENTS[instrumentName];
if (!instrument) {
  console.error(`unknown instrument: ${instrumentName}`);
  process.exit(1);
}

const yahooSymbol = YAHOO_SYMBOLS[instrumentName];
if (!yahooSymbol) {
  console.error(`no Yahoo Finance symbol for ${instrumentName}`);
  process.exit(1);
}

const interval = Number(process.env.INTERVAL ?? DEFAULT_INTERVAL);

let account: Awaited<ReturnType<typeof createAccount>>;
while (true) {
  try {
    account = await createAccount();
    break;
  } catch (err) {
    console.error(
      "createAccount failed, retrying:",
      err instanceof Error ? err.message : err,
    );
    await Bun.sleep(interval);
  }
}
console.log(`account ${account.address}`);
console.log(`interval: ${interval}ms, symbol: ${yahooSymbol}`);

while (true) {
  try {
    await tick();
  } catch (err) {
    console.error(
      "iteration failed:",
      err instanceof Error ? err.message : err,
    );
  }
  await Bun.sleep(interval);
}

async function fetchYahooPrice(symbol: string): Promise<number> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "order-book-scripts/1.0" },
  });
  if (!res.ok) throw new Error(`Yahoo Finance returned ${res.status}`);
  const data = (await res.json()) as {
    chart: {
      result: [{ meta: { regularMarketPrice: number } }];
    };
  };
  return data.chart.result[0].meta.regularMarketPrice;
}

async function tick() {
  const [realPrice, state] = await Promise.all([
    fetchYahooPrice(yahooSymbol),
    fetchState(),
  ]);
  console.log(`real price: $${realPrice.toFixed(4)}`);

  const book = state.instruments[instrument.id];
  if (!book) {
    console.log("instrument not found on-chain, skipping");
    return;
  }

  const anchorQ32 = Number(priceToQ32(realPrice, instrument));

  const askPrices = Object.keys(book.asks)
    .map(Number)
    .filter((p) => BigInt(book.asks[p]!.remainingQuantity) > 0n)
    .sort((a, b) => a - b);
  const bidPrices = Object.keys(book.bids)
    .map(Number)
    .filter((p) => BigInt(book.bids[p]!.remainingQuantity) > 0n)
    .sort((a, b) => b - a);

  let buyLots = 0n;
  let buyQuoteLots = 0n;
  for (const p of askPrices) {
    if (p > anchorQ32) break;
    const available = BigInt(book.asks[p]!.remainingQuantity);
    buyLots += available;
    buyQuoteLots += (available * BigInt(p)) >> 32n;
  }

  let sellLots = 0n;
  let sellQuoteLots = 0n;
  for (const p of bidPrices) {
    if (p < anchorQ32) break;
    const available = BigInt(book.bids[p]!.remainingQuantity);
    sellLots += available;
    sellQuoteLots += (available * BigInt(p)) >> 32n;
  }

  if (buyLots === 0n && sellLots === 0n) {
    console.log("no arbitrage opportunity");
    return;
  }

  if (buyLots > 0n) {
    const quantity = TokenAmount.fromRaw(
      fromLots(buyLots, instrument.baseLotExp),
      instrument.base,
    );
    const depositAmount = TokenAmount.fromRaw(
      fromLots(buyQuoteLots, instrument.quoteLotExp),
      instrument.quote,
    );
    const avgPrice = depositAmount.human / quantity.human;
    console.log(
      `arb buy: ${quantity.human.toFixed(4)} base @ avg $${avgPrice.toFixed(4)}`,
    );
    await deposit(account, { quantity: depositAmount });
    await marketOrder(account, {
      instrument,
      quantity,
      minReceived: quantity,
      side: "buy",
    });
  }

  if (sellLots > 0n) {
    const quantity = TokenAmount.fromRaw(
      fromLots(sellLots, instrument.baseLotExp),
      instrument.base,
    );
    const minReceived = TokenAmount.fromRaw(
      fromLots(sellQuoteLots, instrument.quoteLotExp),
      instrument.quote,
    );
    const avgPrice = minReceived.human / quantity.human;
    console.log(
      `arb sell: ${quantity.human.toFixed(4)} base @ avg $${avgPrice.toFixed(4)}`,
    );
    await deposit(account, { quantity });
    await marketOrder(account, {
      instrument,
      quantity,
      minReceived,
      side: "sell",
    });
  }
}
