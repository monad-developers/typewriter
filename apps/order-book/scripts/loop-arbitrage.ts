import {
  fromLots,
  type InstrumentConfig,
  priceToQ32,
  TokenAmount,
} from "order-book-sdk";
import {
  createAccountRetrying,
  deposit,
  estimateFillToPrice,
  marketOrder,
} from "./src/client";
import { type InstrumentName, instrumentsEnv, intervalEnv } from "./src/env";

const YAHOO_SYMBOLS: Record<InstrumentName, string> = {
  "GOLD/USD": "GC=F",
  "WTIOIL/USD": "CL=F",
  "EUR/USD": "EURUSD=X",
  "SPX/USD": "^GSPC",
  "BTC/USD": "BTC-USD",
};

const targets = instrumentsEnv().map((target) => ({
  ...target,
  yahooSymbol: YAHOO_SYMBOLS[target.name],
}));
const interval = intervalEnv();

const account = await createAccountRetrying(interval);
console.log(`account ${account.accountID}`);
console.log(
  `interval: ${interval}ms, instruments: ${targets.map((t) => `${t.name}(${t.yahooSymbol})`).join(", ")}`,
);

while (true) {
  for (const target of targets) {
    try {
      await tick(target.instrument, target.yahooSymbol, target.name);
    } catch (err) {
      console.error(
        `[${target.name}] iteration failed:`,
        err instanceof Error ? err.message : err,
      );
    }
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

async function tick(
  instrument: InstrumentConfig,
  yahooSymbol: string,
  label: string,
) {
  const realPrice = await fetchYahooPrice(yahooSymbol);
  console.log(`[${label}] real price: $${realPrice.toFixed(4)}`);

  const anchorQ32 = priceToQ32(realPrice, instrument);

  let buyEstimate: Awaited<ReturnType<typeof estimateFillToPrice>>;
  let sellEstimate: Awaited<ReturnType<typeof estimateFillToPrice>>;
  try {
    [buyEstimate, sellEstimate] = await Promise.all([
      estimateFillToPrice({
        instrumentId: instrument.id,
        side: "buy",
        priceQ32: anchorQ32,
      }),
      estimateFillToPrice({
        instrumentId: instrument.id,
        side: "sell",
        priceQ32: anchorQ32,
      }),
    ]);
  } catch (err) {
    console.log(
      `[${label}] estimate failed, skipping (${err instanceof Error ? err.message : err})`,
    );
    return;
  }

  const buyLots = buyEstimate.totalQuantity;
  const buyQuoteLots = buyEstimate.quoteQuantity;
  const sellLots = sellEstimate.totalQuantity;
  const sellQuoteLots = sellEstimate.quoteQuantity;

  if (buyLots === 0n && sellLots === 0n) {
    console.log(`[${label}] no arbitrage opportunity`);
    return;
  }

  const legs: Promise<unknown>[] = [];

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
      `[${label}] arb buy: ${quantity.human.toFixed(4)} base @ avg $${avgPrice.toFixed(4)}`,
    );
    legs.push(
      (async () => {
        await deposit(
          account,
          { quantity: depositAmount },
          { concurrent: true },
        );
        await marketOrder(
          account,
          { instrument, quantity, minReceived: quantity, side: "buy" },
          { concurrent: true },
        );
      })(),
    );
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
      `[${label}] arb sell: ${quantity.human.toFixed(4)} base @ avg $${avgPrice.toFixed(4)}`,
    );
    legs.push(
      (async () => {
        await deposit(account, { quantity }, { concurrent: true });
        await marketOrder(
          account,
          { instrument, quantity, minReceived, side: "sell" },
          { concurrent: true },
        );
      })(),
    );
  }

  await Promise.all(legs);
}
