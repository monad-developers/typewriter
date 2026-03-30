import type { Address } from "viem";

/** 0 = bid, 1 = ask — mirrors Solidity convention */
export type Side = 0 | 1;

/** Mirrors Solidity `enum Mutation` ordering exactly */
export enum MutationType {
  MarketOrder = 0,
  LimitOrder = 1,
  CloseOrder = 2,
  AddAccount = 3,
  AddInstrument = 4,
  AddAsset = 5,
}

export type Tick<quantity = string> = {
  quantity: quantity;
  remainingQuantity: quantity;
  volume: number;
};

export type Order<quantity = string> = {
  quantity: quantity;
  marketId: number;
  tickId: number;
  tickVolume: number;
  side: Side;
};

export type Account<quantity = string> = {
  nonce: number;
  balances: { [assetId: number]: quantity };
  orders: Order<quantity>[];
};

export type Instrument<quantity = string> = {
  baseId: number;
  quoteId: number;
  bids: { [tickId: number]: Tick<quantity> };
  asks: { [tickId: number]: Tick<quantity> };
};

export type State<quantity = string> = {
  assets: Address[];
  accounts: Account<quantity>[];
  instruments: Instrument<quantity>[];
};

export type Fill<quantity = string> = {
  quantity: quantity;
  tickId: number;
};

export type MarketOrder<quantity = string> = {
  id: string;
  type: MutationType.MarketOrder;
  quantity: quantity;
  minReceivedQuantity: quantity;
  marketId: number;
  accountId: number;
  bidOrAsk: Side;
};

export type MarketOrderResolution<quantity = string> = {
  id: string;
  fills: Fill<quantity>[];
};

export type LimitOrder<quantity = string> = {
  id: string;
  type: MutationType.LimitOrder;
  quantity: quantity;
  marketId: number;
  accountId: number;
  tickId: number;
  bidOrAsk: Side;
};

export type LimitOrderResolution<quantity = string> = {
  id: string;
  fills: Fill<quantity>[];
};

export type CloseOrder = {
  id: string;
  type: MutationType.CloseOrder;
  accountId: number;
  orderId: number;
};

export type AddAccount = {
  id: string;
  type: MutationType.AddAccount;
  addr: Address;
};

export type AddInstrument = {
  id: string;
  type: MutationType.AddInstrument;
  baseId: number;
  quoteId: number;
};

export type AddAsset = {
  id: string;
  type: MutationType.AddAsset;
  asset: Address;
};

export type SignedMutation<T> = T & {
  nonce: number;
  deadline: number;
  signature: `0x${string}`;
};

export function resolveAndOrderMutations(
  state: State<bigint>,
  mutations: (
    | MarketOrder<bigint>
    | LimitOrder<bigint>
    | CloseOrder
    | AddAccount
    | AddInstrument
    | AddAsset
  )[],
): (
  | [MarketOrder<bigint>, MarketOrderResolution<bigint>]
  | [LimitOrder<bigint>, LimitOrderResolution<bigint>]
  | CloseOrder
  | AddAccount
  | AddInstrument
  | AddAsset
)[] {
  // TODO: implement ordering, resolution computation, and state application
  throw new Error("Not implemented");
}

export function addAccount(state: State<bigint>): { accountId: number } {
  const accountId = state.accounts.length;
  state.accounts.push({ nonce: 0, balances: {}, orders: [] });
  return { accountId };
}

export function addAsset(
  state: State<bigint>,
  params: AddAsset,
): { assetId: number } {
  const assetId = state.assets.length;
  state.assets.push(params.asset);
  return { assetId };
}

export function addInstrument(
  state: State<bigint>,
  params: AddInstrument,
): { instrumentId: number } {
  if (
    params.baseId >= state.assets.length ||
    params.quoteId >= state.assets.length
  ) {
    throw new Error("Invalid asset ID");
  }
  const instrumentId = state.instruments.length;
  state.instruments.push({
    baseId: params.baseId,
    quoteId: params.quoteId,
    bids: {},
    asks: {},
  });
  return { instrumentId };
}

export function marketOrder(
  state: State<bigint>,
  params: MarketOrder<bigint>,
  resolution: MarketOrderResolution<bigint>,
): void {
  const instrument = state.instruments[params.marketId];
  if (!instrument) throw new Error("Invalid instrument");
  const account = state.accounts[params.accountId];
  if (!account) throw new Error("Invalid account");

  for (const fill of resolution.fills) {
    const opposingSide =
      params.bidOrAsk === 0 ? instrument.asks : instrument.bids;
    const tick = opposingSide[fill.tickId];
    if (!tick) continue;

    tick.remainingQuantity -= fill.quantity;
    if (tick.remainingQuantity === 0n) {
      delete opposingSide[fill.tickId];
    }
  }

  const filledQty = resolution.fills.reduce((sum, f) => sum + f.quantity, 0n);
  if (filledQty < params.minReceivedQuantity) {
    throw new Error("Slippage exceeded");
  }

  const { baseId, quoteId } = instrument;
  const quoteCost = resolution.fills.reduce(
    (sum, f) => sum + f.quantity * BigInt(f.tickId),
    0n,
  );

  if (params.bidOrAsk === 0) {
    account.balances[baseId] = (account.balances[baseId] ?? 0n) + filledQty;
    account.balances[quoteId] = (account.balances[quoteId] ?? 0n) - quoteCost;
  } else {
    account.balances[baseId] = (account.balances[baseId] ?? 0n) - filledQty;
    account.balances[quoteId] = (account.balances[quoteId] ?? 0n) + quoteCost;
  }
}

export function limitOrder(
  state: State<bigint>,
  params: LimitOrder<bigint>,
  resolution: LimitOrderResolution<bigint>,
): void {
  const instrument = state.instruments[params.marketId];
  if (!instrument) throw new Error("Invalid instrument");
  const account = state.accounts[params.accountId];
  if (!account) throw new Error("Invalid account");
  const restingSide = params.bidOrAsk === 0 ? instrument.bids : instrument.asks;

  for (const fill of resolution.fills) {
    const opposingSide =
      params.bidOrAsk === 0 ? instrument.asks : instrument.bids;
    const tick = opposingSide[fill.tickId];
    if (!tick) continue;

    tick.remainingQuantity -= fill.quantity;
    if (tick.remainingQuantity === 0n) {
      delete opposingSide[fill.tickId];
    }
  }

  const filledQty = resolution.fills.reduce((sum, f) => sum + f.quantity, 0n);
  const remaining = params.quantity - filledQty;

  if (remaining > 0n) {
    const tick = restingSide[params.tickId] ?? {
      quantity: 0n,
      remainingQuantity: 0n,
      volume: 0,
    };
    tick.quantity += remaining;
    tick.remainingQuantity += remaining;
    tick.volume += 1;
    restingSide[params.tickId] = tick;
  }

  account.orders.push({
    quantity: params.quantity,
    marketId: params.marketId,
    tickId: params.tickId,
    tickVolume: restingSide[params.tickId]?.volume ?? 0,
    side: params.bidOrAsk,
  });

  const { baseId, quoteId } = instrument;
  const quoteFilled = resolution.fills.reduce(
    (sum, f) => sum + f.quantity * BigInt(f.tickId),
    0n,
  );

  if (params.bidOrAsk === 0) {
    account.balances[baseId] = (account.balances[baseId] ?? 0n) + filledQty;
    account.balances[quoteId] = (account.balances[quoteId] ?? 0n) - quoteFilled;
    if (remaining > 0n) {
      account.balances[quoteId] -= remaining * BigInt(params.tickId);
    }
  } else {
    account.balances[baseId] =
      (account.balances[baseId] ?? 0n) - params.quantity;
    account.balances[quoteId] = (account.balances[quoteId] ?? 0n) + quoteFilled;
  }
}

export function closeOrder(state: State<bigint>, params: CloseOrder): void {
  const account = state.accounts[params.accountId];
  if (!account) throw new Error("Invalid account");
  const order = account.orders[params.orderId];
  if (!order) throw new Error("Order not found");
  if (order.quantity === 0n) throw new Error("Order already closed");

  const instrument = state.instruments[order.marketId];
  if (!instrument) throw new Error("Invalid instrument");
  const side = order.side === 0 ? instrument.bids : instrument.asks;
  const tick = side[order.tickId];

  if (tick) {
    const unfilled =
      tick.quantity > 0n
        ? (order.quantity * tick.remainingQuantity) / tick.quantity
        : 0n;

    tick.remainingQuantity -= unfilled;
    tick.quantity -= order.quantity;

    if (tick.quantity === 0n) {
      delete side[order.tickId];
    }

    const { baseId, quoteId } = instrument;
    if (order.side === 0) {
      account.balances[quoteId] =
        (account.balances[quoteId] ?? 0n) + unfilled * BigInt(order.tickId);
    } else {
      account.balances[baseId] = (account.balances[baseId] ?? 0n) + unfilled;
    }
  }

  order.quantity = 0n;
}
