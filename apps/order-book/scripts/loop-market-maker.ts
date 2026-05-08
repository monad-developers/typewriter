import {
  baseToQuote,
  type InstrumentConfig,
  priceToQ32,
  q32ToPrice,
  TokenAmount,
} from "order-book-sdk";
import { INSTRUMENTS } from "./src/constants";
import {
  type Account,
  type AccountOrder,
  closeOrder,
  createAccount,
  deposit,
  fetchAccountOrders,
  fetchPrice,
  fetchTicks,
  limitOrder,
} from "./src/sdk";

type Tick = { quantity: bigint; remainingQuantity: bigint; volume: number };
type TickLookup = (side: 0 | 1, priceQ32: bigint) => Tick | null;

const RANGES = [
  { min: 0, max: 1 },
  { min: 1, max: 5 },
  { min: 5, max: 10 },
  { min: 10, max: 25 },
  { min: 25, max: 100 },
  { min: 100, max: 250 },
  { min: 250, max: 1000 },
  { min: 1000, max: 2500 },
  { min: 2500, max: 10000 },
];
const DEFAULT_INTERVAL = 10_000;

if (!process.env.QUANTITY) {
  console.error("QUANTITY env var is required (e.g. 1 for 1 unit per level)");
  process.exit(1);
}

const humanQuantity = Number(process.env.QUANTITY);
const instruments = resolveInstruments();
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
console.log(
  `interval: ${interval}ms, instruments: ${instruments.map((i) => i.name).join(", ")}`,
);

while (true) {
  for (const inst of instruments) {
    try {
      await tick(inst.instrument, inst.name);
    } catch (err) {
      console.error(
        `[${inst.name}] iteration failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  await Bun.sleep(interval);
}

function resolveInstruments(): {
  name: keyof typeof INSTRUMENTS;
  instrument: InstrumentConfig;
}[] {
  if (!process.env.INSTRUMENT) {
    return Object.entries(INSTRUMENTS).map(([name, instrument]) => ({
      name: name as keyof typeof INSTRUMENTS,
      instrument,
    }));
  }
  const name = process.env.INSTRUMENT as keyof typeof INSTRUMENTS;
  const instrument = INSTRUMENTS[name];
  if (!instrument) {
    console.error(`unknown instrument: ${name}`);
    process.exit(1);
  }
  return [{ name, instrument }];
}

async function tick(instrument: InstrumentConfig, label: string) {
  const [priceInfo, orders] = await Promise.all([
    fetchPrice(instrument.id),
    fetchAccountOrders(account.accountHex, instrument.id),
  ]);

  if (priceInfo.priceQ32 === null) {
    console.log(`[${label}] no price available, skipping`);
    return;
  }
  const midPrice = q32ToPrice(priceInfo.priceQ32, instrument);
  console.log(`[${label}] mid price: $${midPrice.toFixed(4)}`);

  const candidates: { price: number; side: "buy" | "sell" }[] = [];
  for (const range of RANGES) {
    const midBps = (range.min + range.max) / 2;
    candidates.push({ price: midPrice * (1 - midBps / 10000), side: "buy" });
    candidates.push({ price: midPrice * (1 + midBps / 10000), side: "sell" });
  }

  const orderQueries = orders.map((o) => ({
    side: (o.side === 0 ? "buy" : "sell") as "buy" | "sell",
    priceQ32: o.price,
  }));
  const candidateQueries = candidates.map((c) => ({
    side: c.side,
    priceQ32: priceToQ32(c.price, instrument),
  }));

  const allQueries = [...orderQueries, ...candidateQueries];
  const allTicks = await fetchTicks(instrument.id, allQueries);

  const tickLookup: TickLookup = (side, priceQ32) => {
    for (let i = 0; i < allQueries.length; i++) {
      const q = allQueries[i]!;
      const qSide = q.side === "buy" ? 0 : 1;
      if (qSide === side && q.priceQ32 === priceQ32) return allTicks[i] ?? null;
    }
    return null;
  };

  const filledIds = findFilledOrders(orders, tickLookup);
  if (filledIds.length > 0) {
    console.log(`[${label}] closing ${filledIds.length} filled orders...`);
    await Promise.all(
      filledIds.map((orderId) =>
        closeOrder(account, { orderId }, { concurrent: true }),
      ),
    );
  }

  const covered = getCoveredRanges(orders, tickLookup, midPrice, instrument);
  const needed = getMissingOrders(covered, candidates, tickLookup, instrument);

  if (needed.length === 0) {
    console.log(`[${label}] all ranges covered`);
    return;
  }

  await depositForOrders(account, needed, instrument, label);

  await Promise.all(
    needed.map((order) => {
      const quantity = TokenAmount.from(humanQuantity, instrument.base);
      console.log(
        `[${label}] placing ${order.side}: ${quantity.human} @ $${order.price.toFixed(4)}`,
      );
      return limitOrder(
        account,
        { instrument, quantity, price: order.price, side: order.side },
        { concurrent: true },
      );
    }),
  );

  console.log(`[${label}] placed ${needed.length} orders`);
}

function orderBps(
  order: AccountOrder,
  midPrice: number,
  instrument: InstrumentConfig,
): number {
  const price = q32ToPrice(order.price, instrument);
  return (Math.abs(price - midPrice) / midPrice) * 10000;
}

function rangeKey(side: "buy" | "sell", rangeIndex: number): string {
  return `${side}:${rangeIndex}`;
}

function findRangeIndex(bps: number): number | null {
  for (let i = 0; i < RANGES.length; i++) {
    if (bps >= RANGES[i]!.min && bps < RANGES[i]!.max) return i;
  }
  return null;
}

function getCoveredRanges(
  orders: AccountOrder[],
  tickLookup: TickLookup,
  midPrice: number,
  instrument: InstrumentConfig,
): Set<string> {
  const covered = new Set<string>();
  for (const order of orders) {
    if (order.quantity === 0n) continue;

    const tick = tickLookup(order.side, order.price);
    if (!tick || tick.volume > order.tickVolume) continue;

    const bps = orderBps(order, midPrice, instrument);
    const ri = findRangeIndex(bps);
    if (ri === null) continue;

    const side = order.side === 0 ? "buy" : "sell";
    covered.add(rangeKey(side, ri));
  }
  return covered;
}

function getMissingOrders(
  covered: Set<string>,
  candidates: { price: number; side: "buy" | "sell" }[],
  tickLookup: TickLookup,
  instrument: InstrumentConfig,
): { price: number; side: "buy" | "sell" }[] {
  const out: { price: number; side: "buy" | "sell" }[] = [];

  for (let i = 0; i < RANGES.length; i++) {
    const buyCandidate = candidates[i * 2]!;
    const sellCandidate = candidates[i * 2 + 1]!;

    if (!covered.has(rangeKey("buy", i))) {
      const tick = tickLookup(0, priceToQ32(buyCandidate.price, instrument));
      const partiallyFilled =
        tick !== null && tick.remainingQuantity !== tick.quantity;
      if (!partiallyFilled) {
        out.push({ price: buyCandidate.price, side: "buy" });
      }
    }

    if (!covered.has(rangeKey("sell", i))) {
      const tick = tickLookup(1, priceToQ32(sellCandidate.price, instrument));
      const partiallyFilled =
        tick !== null && tick.remainingQuantity !== tick.quantity;
      if (!partiallyFilled) {
        out.push({ price: sellCandidate.price, side: "sell" });
      }
    }
  }

  return out;
}

function findFilledOrders(
  orders: AccountOrder[],
  tickLookup: TickLookup,
): number[] {
  const filled: number[] = [];
  for (const order of orders) {
    if (order.quantity === 0n) continue;
    const tick = tickLookup(order.side, order.price);
    if (!tick || tick.volume > order.tickVolume) {
      filled.push(order.orderId);
    }
  }
  return filled;
}

async function depositForOrders(
  account: Account,
  orders: { price: number; side: "buy" | "sell" }[],
  instrument: InstrumentConfig,
  label: string,
) {
  let totalBase = 0n;
  let totalQuote = 0n;

  for (const order of orders) {
    const quantity = TokenAmount.from(humanQuantity, instrument.base);
    if (order.side === "buy") {
      totalQuote += baseToQuote(
        quantity,
        priceToQ32(order.price, instrument),
        instrument,
      ).raw;
    } else {
      totalBase += quantity.raw;
    }
  }

  const deposits: Promise<unknown>[] = [];
  if (totalBase > 0n) {
    const amount = TokenAmount.fromRaw(totalBase, instrument.base);
    console.log(`[${label}] depositing ${amount.human.toFixed(4)} base...`);
    deposits.push(deposit(account, { quantity: amount }, { concurrent: true }));
  }
  if (totalQuote > 0n) {
    const amount = TokenAmount.fromRaw(totalQuote, instrument.quote);
    console.log(`[${label}] depositing ${amount.human.toFixed(4)} quote...`);
    deposits.push(deposit(account, { quantity: amount }, { concurrent: true }));
  }
  await Promise.all(deposits);
}
