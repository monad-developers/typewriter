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

    const fillQty =
      remaining < tick.remainingQuantity ? remaining : tick.remainingQuantity;
    fills.push({ quantity: fillQty, price: BigInt(p) });
    remaining -= fillQty;
  }

  return { fills };
}

export function resolveAndOrderMutations(
  state: State<bigint>,
  mutations: TaggedMutation[],
): ResolvedMutation[] {
  const sorted = [...mutations].sort((a, b) => a.type - b.type);

  const result: ResolvedMutation[] = [];

  for (const m of sorted) {
    if (m.type === MutationType.MarketOrder) {
      const instrument = state.instruments[m.mutation.instrumentId];
      if (!instrument) throw new Error("InvalidInstrument");
      const resolution = resolveMarketOrder(instrument, m.mutation);
      result.push({ ...m, resolution });
    } else {
      result.push(m);
    }
  }

  return result;
}
