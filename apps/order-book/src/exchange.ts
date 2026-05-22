import type { Address, Hex } from "viem";

export type Side = 0 | 1;
export type KeyType = 0 | 1 | 2; // P256, WebAuthnP256, Secp256k1

export const PERM_AUTHORIZE = 1 << 0;
export const PERM_REVOKE = 1 << 1;
export const PERM_CLOSE_ORDER = 1 << 2;
export const PERM_LIMIT_ORDER = 1 << 3;
export const PERM_MARKET_ORDER = 1 << 4;
export const PERM_DEPOSIT = 1 << 5;
export const PERM_WITHDRAW = 1 << 6;
export const PERM_ADD_INSTRUMENT = 1 << 7;
export const PERM_CHANGE_ORDER = 1 << 8;
export const ALL_PERMISSIONS =
  PERM_AUTHORIZE |
  PERM_REVOKE |
  PERM_CLOSE_ORDER |
  PERM_LIMIT_ORDER |
  PERM_MARKET_ORDER |
  PERM_DEPOSIT |
  PERM_WITHDRAW |
  PERM_ADD_INSTRUMENT |
  PERM_CHANGE_ORDER;

export type Key = {
  expiry: number;
  keyType: KeyType;
  permissions: number;
  publicKey: Hex;
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

export type ChangeOrder<quantity = string> = {
  orderId: number;
  price: quantity;
};

export type Deposit<quantity = string> = {
  asset: Address;
  amount: quantity;
};

export type Withdrawal<quantity = string> = {
  asset: Address;
  amount: quantity;
};

export type AddInstrument = {
  instrumentId: number;
  base: Address;
  quote: Address;
  baseLotExp: number;
  quoteLotExp: number;
};

export type Initialize = {
  expiry: number;
  rootKeyType: number;
  keyType: number;
  permissions: number;
  rootPublicKey: Hex;
  publicKey: Hex;
};

export type Authorize = {
  expiry: number;
  keyType: number;
  permissions: number;
  publicKey: Hex;
};

export type Revoke = {
  keyId: number;
};

export enum MutationType {
  Initialize = 0,
  Authorize = 1,
  Revoke = 2,
  CloseOrder = 3,
  ChangeOrder = 4,
  LimitOrder = 5,
  MarketOrder = 6,
  AddInstrument = 7,
  Deposit = 8,
  Withdrawal = 9,
}
