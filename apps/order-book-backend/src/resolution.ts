import type {
  Fill,
  Instrument,
  MarketOrder,
  MarketOrderResolution,
  ResolvedMutation,
  State,
  TaggedMutation,
} from "./exchange";
import { MutationType } from "./exchange";

export function resolveMarketOrder(
  instrument: Instrument<bigint>,
  order: MarketOrder<bigint>,
  claimed: Map<number, bigint>,
): MarketOrderResolution<bigint> {
  const opposingSide = order.bidOrAsk === 0 ? instrument.asks : instrument.bids;
  const prices = Object.keys(opposingSide)
    .map(Number)
    .sort((a, b) => (order.bidOrAsk === 0 ? a - b : b - a));

  const fills: Fill<bigint>[] = [];
  let remaining = order.quantity;

  for (const p of prices) {
    if (remaining <= 0n) break;
    const tick = opposingSide[p];
    if (!tick || tick.remainingQuantity <= 0n) continue;

    const available = tick.remainingQuantity - (claimed.get(p) ?? 0n);
    if (available <= 0n) continue;

    const fillQty = remaining < available ? remaining : available;
    fills.push({ quantity: fillQty, price: BigInt(p) });
    remaining -= fillQty;
    claimed.set(p, (claimed.get(p) ?? 0n) + fillQty);
  }

  if (remaining > 0n)
    throw new Error(
      `InsufficientLiquidity: resolveMarketOrder remaining=${remaining} quantity=${order.quantity} instrumentId=${order.instrumentId} side=${order.bidOrAsk === 0 ? "buy" : "sell"}`,
    );

  let totalReceived = 0n;
  for (const fill of fills) {
    if (order.bidOrAsk === 0) {
      totalReceived += fill.quantity;
    } else {
      totalReceived += (fill.quantity * fill.price) >> 32n;
    }
  }
  if (totalReceived < order.minReceivedQuantity)
    throw new Error(
      `SlippageExceeded: resolveMarketOrder totalReceived=${totalReceived} minReceivedQuantity=${order.minReceivedQuantity} instrumentId=${order.instrumentId}`,
    );

  return { fills };
}

export function resolveAndOrderMutations(
  state: State<bigint>,
  mutations: TaggedMutation[],
): ResolvedMutation[] {
  const sorted = [...mutations].sort((a, b) => a.type - b.type);

  const result: ResolvedMutation[] = [];
  const claimed = new Map<number, bigint>();

  for (const m of sorted) {
    if (m.type === MutationType.MarketOrder) {
      const instrument = state.instruments[m.mutation.instrumentId];
      if (!instrument)
        throw new Error(
          `InvalidInstrument: resolveAndOrderMutations instrumentId=${m.mutation.instrumentId} account=${m.account}`,
        );
      const resolution = resolveMarketOrder(instrument, m.mutation, claimed);
      result.push({ ...m, resolution });
    } else {
      result.push(m);
    }
  }

  return result;
}
