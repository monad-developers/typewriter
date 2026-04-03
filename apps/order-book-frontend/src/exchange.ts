import type { Address } from "viem";

export type Side = 0 | 1;

export type State<quantity = string> = {
  accounts: Record<Address, Account<quantity>>;
  instruments: Record<number, Instrument<quantity>>;
};

export type Account<quantity = string> = {
  nonce: quantity;
  balances: Record<Address, quantity>;
  orders: Order<quantity>[];
};

export type Order<quantity = string> = {
  quantity: quantity;
  instrumentId: number;
  price: quantity;
  tickVolume: number;
  side: Side;
};

export type Instrument<quantity = string> = {
  base: Address;
  baseLotExp: number;
  quote: Address;
  quoteLotExp: number;
  bids: Record<number, Tick<quantity>>;
  asks: Record<number, Tick<quantity>>;
};

export type Tick<quantity = string> = {
  quantity: quantity;
  remainingQuantity: quantity;
  volume: number;
};

export type MarketOrder<quantity = string> = {
  quantity: quantity;
  minReceivedQuantity: quantity;
  instrumentId: number;
  bidOrAsk: Side;
};

export type Fill<quantity = string> = {
  quantity: quantity;
  price: quantity;
};

export type MarketOrderResolution<quantity = string> = {
  fills: Fill<quantity>[];
};

export type LimitOrder<quantity = string> = {
  quantity: quantity;
  instrumentId: number;
  price: quantity;
  bidOrAsk: Side;
};

export type CloseOrder = {
  orderId: number;
};

export type Deposit<quantity = string> = {
  asset: Address;
  amount: quantity;
};

export type Withdrawal<quantity = string> = {
  asset: Address;
  amount: quantity;
};

export type AddInstrumentParams = {
  instrumentId: number;
  base: Address;
  quote: Address;
  baseLotExp: number;
  quoteLotExp: number;
};

export enum MutationType {
  CloseOrder = 0,
  LimitOrder = 1,
  MarketOrder = 2,
  AddInstrument = 3,
  Deposit = 4,
  Withdrawal = 5,
}

export type Signed<quantity = string> = {
  account: Address;
  nonce: quantity;
  deadline: quantity;
  signature: `0x${string}`;
};

export type TaggedMutation =
  | ({ type: MutationType.CloseOrder; mutation: CloseOrder } & Signed<bigint>)
  | ({ type: MutationType.LimitOrder; mutation: LimitOrder<bigint> } & Signed<bigint>)
  | ({ type: MutationType.MarketOrder; mutation: MarketOrder<bigint> } & Signed<bigint>)
  | { type: MutationType.AddInstrument; mutation: AddInstrumentParams }
  | ({ type: MutationType.Deposit; mutation: Deposit<bigint> } & Signed<bigint>)
  | ({ type: MutationType.Withdrawal; mutation: Withdrawal<bigint> } & Signed<bigint>);

export type ResolvedMutation =
  | ({ type: MutationType.CloseOrder; mutation: CloseOrder } & Signed<bigint>)
  | ({ type: MutationType.LimitOrder; mutation: LimitOrder<bigint> } & Signed<bigint>)
  | ({
      type: MutationType.MarketOrder;
      mutation: MarketOrder<bigint>;
      resolution: MarketOrderResolution<bigint>;
    } & Signed<bigint>)
  | { type: MutationType.AddInstrument; mutation: AddInstrumentParams }
  | ({ type: MutationType.Deposit; mutation: Deposit<bigint> } & Signed<bigint>)
  | ({ type: MutationType.Withdrawal; mutation: Withdrawal<bigint> } & Signed<bigint>);

export function createState(): State<bigint> {
  return { accounts: {}, instruments: {} };
}

export function createAccount(): Account<bigint> {
  return { nonce: 0n, balances: {}, orders: [] };
}

export function createOrder(): Order<bigint> {
  return { quantity: 0n, instrumentId: 0, price: 0n, tickVolume: 0, side: 0 };
}

export function createInstrument(): Instrument<bigint> {
  return {
    base: "0x0000000000000000000000000000000000000000",
    baseLotExp: 0,
    quote: "0x0000000000000000000000000000000000000000",
    quoteLotExp: 0,
    bids: {},
    asks: {},
  };
}

export function createTick(): Tick<bigint> {
  return { quantity: 0n, remainingQuantity: 0n, volume: 0 };
}

function n(v: string): bigint {
  return BigInt(v);
}
function s(v: bigint): string {
  return v.toString();
}

export function decodeTick(t: Tick): Tick<bigint> {
  return {
    quantity: n(t.quantity),
    remainingQuantity: n(t.remainingQuantity),
    volume: t.volume,
  };
}

export function encodeTick(t: Tick<bigint>): Tick {
  return {
    quantity: s(t.quantity),
    remainingQuantity: s(t.remainingQuantity),
    volume: t.volume,
  };
}

export function decodeOrder(o: Order): Order<bigint> {
  return {
    quantity: n(o.quantity),
    instrumentId: o.instrumentId,
    price: n(o.price),
    tickVolume: o.tickVolume,
    side: o.side,
  };
}

export function encodeOrder(o: Order<bigint>): Order {
  return {
    quantity: s(o.quantity),
    instrumentId: o.instrumentId,
    price: s(o.price),
    tickVolume: o.tickVolume,
    side: o.side,
  };
}

export function decodeAccount(a: Account): Account<bigint> {
  const balances: Record<Address, bigint> = {};
  for (const [k, v] of Object.entries(a.balances)) {
    balances[k as Address] = n(v);
  }
  return { nonce: n(a.nonce), balances, orders: a.orders.map(decodeOrder) };
}

export function encodeAccount(a: Account<bigint>): Account {
  const balances: Record<Address, string> = {};
  for (const [k, v] of Object.entries(a.balances)) {
    balances[k as Address] = s(v);
  }
  return { nonce: s(a.nonce), balances, orders: a.orders.map(encodeOrder) };
}

function decodeTicks(
  ticks: Record<number, Tick>,
): Record<number, Tick<bigint>> {
  const out: Record<number, Tick<bigint>> = {};
  for (const [k, v] of Object.entries(ticks)) {
    out[Number(k)] = decodeTick(v);
  }
  return out;
}

function encodeTicks(
  ticks: Record<number, Tick<bigint>>,
): Record<number, Tick> {
  const out: Record<number, Tick> = {};
  for (const [k, v] of Object.entries(ticks)) {
    out[Number(k)] = encodeTick(v);
  }
  return out;
}

export function decodeInstrument(i: Instrument): Instrument<bigint> {
  return {
    base: i.base,
    baseLotExp: i.baseLotExp,
    quote: i.quote,
    quoteLotExp: i.quoteLotExp,
    bids: decodeTicks(i.bids),
    asks: decodeTicks(i.asks),
  };
}

export function encodeInstrument(i: Instrument<bigint>): Instrument {
  return {
    base: i.base,
    baseLotExp: i.baseLotExp,
    quote: i.quote,
    quoteLotExp: i.quoteLotExp,
    bids: encodeTicks(i.bids),
    asks: encodeTicks(i.asks),
  };
}

export function decodeState(st: State): State<bigint> {
  const accounts: Record<Address, Account<bigint>> = {};
  for (const [k, v] of Object.entries(st.accounts)) {
    accounts[k as Address] = decodeAccount(v);
  }
  const instruments: Record<number, Instrument<bigint>> = {};
  for (const [k, v] of Object.entries(st.instruments)) {
    instruments[Number(k)] = decodeInstrument(v);
  }
  return { accounts, instruments };
}

export function encodeState(st: State<bigint>): State {
  const accounts: Record<Address, Account> = {};
  for (const [k, v] of Object.entries(st.accounts)) {
    accounts[k as Address] = encodeAccount(v);
  }
  const instruments: Record<number, Instrument> = {};
  for (const [k, v] of Object.entries(st.instruments)) {
    instruments[Number(k)] = encodeInstrument(v);
  }
  return { accounts, instruments };
}

export function decodeFill(f: Fill): Fill<bigint> {
  return { quantity: n(f.quantity), price: n(f.price) };
}

export function encodeFill(f: Fill<bigint>): Fill {
  return { quantity: s(f.quantity), price: s(f.price) };
}

export function decodeMarketOrderResolution(
  r: MarketOrderResolution,
): MarketOrderResolution<bigint> {
  return { fills: r.fills.map(decodeFill) };
}

export function encodeMarketOrderResolution(
  r: MarketOrderResolution<bigint>,
): MarketOrderResolution {
  return { fills: r.fills.map(encodeFill) };
}

export function decodeMarketOrder(o: MarketOrder): MarketOrder<bigint> {
  return {
    quantity: n(o.quantity),
    minReceivedQuantity: n(o.minReceivedQuantity),
    instrumentId: o.instrumentId,
    bidOrAsk: o.bidOrAsk,
  };
}

export function encodeMarketOrder(o: MarketOrder<bigint>): MarketOrder {
  return {
    quantity: s(o.quantity),
    minReceivedQuantity: s(o.minReceivedQuantity),
    instrumentId: o.instrumentId,
    bidOrAsk: o.bidOrAsk,
  };
}

export function decodeLimitOrder(o: LimitOrder): LimitOrder<bigint> {
  return {
    quantity: n(o.quantity),
    instrumentId: o.instrumentId,
    price: n(o.price),
    bidOrAsk: o.bidOrAsk,
  };
}

export function encodeLimitOrder(o: LimitOrder<bigint>): LimitOrder {
  return {
    quantity: s(o.quantity),
    instrumentId: o.instrumentId,
    price: s(o.price),
    bidOrAsk: o.bidOrAsk,
  };
}

export function decodeDeposit(d: Deposit): Deposit<bigint> {
  return { asset: d.asset, amount: n(d.amount) };
}

export function encodeDeposit(d: Deposit<bigint>): Deposit {
  return { asset: d.asset, amount: s(d.amount) };
}

export function decodeWithdrawal(w: Withdrawal): Withdrawal<bigint> {
  return { asset: w.asset, amount: n(w.amount) };
}

export function encodeWithdrawal(w: Withdrawal<bigint>): Withdrawal {
  return { asset: w.asset, amount: s(w.amount) };
}

export function decodeSigned(s: Signed): Signed<bigint> {
  return { account: s.account, nonce: BigInt(s.nonce), deadline: BigInt(s.deadline), signature: s.signature };
}

export function encodeSigned(s: Signed<bigint>): Signed {
  return { account: s.account, nonce: s.nonce.toString(), deadline: s.deadline.toString(), signature: s.signature };
}

export function getAccount(
  state: State<bigint>,
  account: Address,
): Account<bigint> {
  if (!state.accounts[account]) {
    state.accounts[account] = createAccount();
  }
  return state.accounts[account];
}

function settleFill(
  state: State<bigint>,
  fill: Fill<bigint>,
  instrument: Instrument<bigint>,
  takerSide: Side,
  takerAccount: Address,
): void {
  const ticks = takerSide === 0 ? instrument.asks : instrument.bids;
  const tick = ticks[Number(fill.price)];
  if (!tick || fill.quantity > tick.remainingQuantity)
    throw new Error("InvalidTick");

  tick.remainingQuantity -= fill.quantity;
  if (tick.remainingQuantity === 0n) {
    tick.volume++;
    tick.quantity = 0n;
    tick.remainingQuantity = 0n;
  }

  const rBase = fill.quantity << BigInt(instrument.baseLotExp);
  const rQuote =
    ((fill.quantity * fill.price) >> 32n) << BigInt(instrument.quoteLotExp);
  const taker = getAccount(state, takerAccount);

  if (takerSide === 0) {
    if ((taker.balances[instrument.quote] ?? 0n) < rQuote)
      throw new Error("InsufficientBalance");
    taker.balances[instrument.quote] =
      (taker.balances[instrument.quote] ?? 0n) - rQuote;
    taker.balances[instrument.base] =
      (taker.balances[instrument.base] ?? 0n) + rBase;
  } else {
    if ((taker.balances[instrument.base] ?? 0n) < rBase)
      throw new Error("InsufficientBalance");
    taker.balances[instrument.base] =
      (taker.balances[instrument.base] ?? 0n) - rBase;
    taker.balances[instrument.quote] =
      (taker.balances[instrument.quote] ?? 0n) + rQuote;
  }
}

export function handleMarketOrder(
  state: State<bigint>,
  order: MarketOrder<bigint>,
  resolution: MarketOrderResolution<bigint>,
  account: Address,
): void {
  const instrument = state.instruments[order.instrumentId];
  if (!instrument) throw new Error("InvalidInstrument");

  let totalFilled = 0n;
  let totalReceived = 0n;
  for (const fill of resolution.fills) {
    totalFilled += fill.quantity;
    settleFill(state, fill, instrument, order.bidOrAsk, account);

    if (order.bidOrAsk === 0) {
      totalReceived += fill.quantity;
    } else {
      totalReceived += (fill.quantity * fill.price) >> 32n;
    }
  }

  if (totalFilled !== order.quantity) throw new Error("InvalidMutation");
  if (totalReceived < order.minReceivedQuantity)
    throw new Error("SlippageExceeded");
}

export function handleLimitOrder(
  state: State<bigint>,
  order: LimitOrder<bigint>,
  account: Address,
): void {
  const instrument = state.instruments[order.instrumentId];
  if (!instrument) throw new Error("InvalidInstrument");

  const ticks = order.bidOrAsk === 0 ? instrument.bids : instrument.asks;
  const priceKey = Number(order.price);
  if (!ticks[priceKey]) {
    ticks[priceKey] = createTick();
  }
  const tick = ticks[priceKey]!;

  if (tick.remainingQuantity !== tick.quantity)
    throw new Error("TickPartiallyFilled");

  const acc = getAccount(state, account);
  if (order.bidOrAsk === 0) {
    const rLock =
      ((order.quantity * order.price) >> 32n) << BigInt(instrument.quoteLotExp);
    if ((acc.balances[instrument.quote] ?? 0n) < rLock)
      throw new Error("InsufficientBalance");
    acc.balances[instrument.quote] =
      (acc.balances[instrument.quote] ?? 0n) - rLock;
  } else {
    const rBase = order.quantity << BigInt(instrument.baseLotExp);
    if ((acc.balances[instrument.base] ?? 0n) < rBase)
      throw new Error("InsufficientBalance");
    acc.balances[instrument.base] =
      (acc.balances[instrument.base] ?? 0n) - rBase;
  }

  tick.quantity += order.quantity;
  tick.remainingQuantity += order.quantity;

  acc.orders.push({
    quantity: order.quantity,
    instrumentId: order.instrumentId,
    price: order.price,
    tickVolume: tick.volume,
    side: order.bidOrAsk,
  });
}

export function handleCloseOrder(
  state: State<bigint>,
  close: CloseOrder,
  account: Address,
): void {
  const acc = getAccount(state, account);
  const order = acc.orders[close.orderId];
  if (!order || order.quantity === 0n) throw new Error("OrderNotFound");

  const instrument = state.instruments[order.instrumentId];
  if (!instrument) throw new Error("InvalidInstrument");

  const ticks = order.side === 0 ? instrument.bids : instrument.asks;
  const priceKey = Number(order.price);
  const tick = ticks[priceKey];

  let filledQuantity: bigint;
  let unfilledQuantity: bigint;

  if (!tick || tick.volume > order.tickVolume) {
    filledQuantity = order.quantity;
    unfilledQuantity = 0n;
  } else {
    const consumed = tick.quantity - tick.remainingQuantity;
    filledQuantity =
      tick.quantity > 0n ? (order.quantity * consumed) / tick.quantity : 0n;
    unfilledQuantity = order.quantity - filledQuantity;
  }

  if (tick && unfilledQuantity > 0n) {
    tick.quantity -= unfilledQuantity;
    tick.remainingQuantity -= unfilledQuantity;
    if (tick.quantity === 0n) {
      delete ticks[priceKey];
    }
  }

  if (order.side === 0) {
    acc.balances[instrument.quote] =
      (acc.balances[instrument.quote] ?? 0n) +
      (((unfilledQuantity * order.price) >> 32n) <<
        BigInt(instrument.quoteLotExp));
    acc.balances[instrument.base] =
      (acc.balances[instrument.base] ?? 0n) +
      (filledQuantity << BigInt(instrument.baseLotExp));
  } else {
    acc.balances[instrument.base] =
      (acc.balances[instrument.base] ?? 0n) +
      (unfilledQuantity << BigInt(instrument.baseLotExp));
    acc.balances[instrument.quote] =
      (acc.balances[instrument.quote] ?? 0n) +
      (((filledQuantity * order.price) >> 32n) <<
        BigInt(instrument.quoteLotExp));
  }

  order.quantity = 0n;
}

export function handleDeposit(
  state: State<bigint>,
  params: Deposit<bigint>,
  account: Address,
): void {
  const acc = getAccount(state, account);
  acc.balances[params.asset] =
    (acc.balances[params.asset] ?? 0n) + params.amount;
}

export function handleWithdrawal(
  state: State<bigint>,
  params: Withdrawal<bigint>,
  account: Address,
): void {
  const acc = getAccount(state, account);
  if ((acc.balances[params.asset] ?? 0n) < params.amount)
    throw new Error("InsufficientBalance");
  acc.balances[params.asset] =
    (acc.balances[params.asset] ?? 0n) - params.amount;
}

export function handleAddInstrument(
  state: State<bigint>,
  params: AddInstrumentParams,
): void {
  if (state.instruments[params.instrumentId])
    throw new Error("InstrumentAlreadyExists");
  state.instruments[params.instrumentId] = {
    base: params.base,
    baseLotExp: params.baseLotExp,
    quote: params.quote,
    quoteLotExp: params.quoteLotExp,
    bids: {},
    asks: {},
  };
}
