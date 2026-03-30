import type { Address } from "viem";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mutation input types
// ---------------------------------------------------------------------------

export type Fill<quantity = string> = {
  quantity: quantity;
  tickId: number;
};

export type MarketOrderInput<quantity = string> = {
  quantity: quantity;
  minReceivedQuantity: quantity;
  marketId: number;
  accountId: number;
  bidOrAsk: Side;
};

export type MarketOrderResolution<quantity = string> = {
  fills: Fill<quantity>[];
};

export type LimitOrderInput<quantity = string> = {
  quantity: quantity;
  marketId: number;
  accountId: number;
  tickId: number;
  bidOrAsk: Side;
};

export type LimitOrderResolution<quantity = string> = {
  fills: Fill<quantity>[];
};

export type CloseOrderInput = {
  accountId: number;
  orderId: number;
};

export type AddAccountInput = {
  addr: Address;
};

export type AddInstrumentInput = {
  baseId: number;
  quoteId: number;
};

export type AddAssetInput = {
  asset: Address;
};

// ---------------------------------------------------------------------------
// Signed wrapper — for mutations requiring user auth
// ---------------------------------------------------------------------------

export type SignedMutation<T> = T & {
  nonce: number;
  deadline: number;
  signature: `0x${string}`;
};
