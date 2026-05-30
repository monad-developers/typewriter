import type { Address } from "ox/Address";

export const USD: Address = "0x1111111111111111111111111111111111111111";
export const GOLD: Address = "0x2222222222222222222222222222222222222222";
export const WTIOIL: Address = "0x3333333333333333333333333333333333333333";
export const EUR: Address = "0x4444444444444444444444444444444444444444";
export const SPX: Address = "0x5555555555555555555555555555555555555555";
export const BTC: Address = "0x6666666666666666666666666666666666666666";

export const ASSETS = [USD, GOLD, WTIOIL, EUR, SPX, BTC] as const;

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

export const DEFAULT_NON_ROOT_PERMISSIONS =
  ALL_PERMISSIONS & ~(PERM_AUTHORIZE | PERM_REVOKE | PERM_WITHDRAW);

export const INSTRUMENTS = {
  "GOLD/USD": {
    id: 0,
    base: GOLD,
    quote: USD,
    baseLotExp: 35,
    quoteLotExp: 46,
  },
  "WTIOIL/USD": {
    id: 1,
    base: WTIOIL,
    quote: USD,
    baseLotExp: 40,
    quoteLotExp: 46,
  },
  "EUR/USD": {
    id: 2,
    base: EUR,
    quote: USD,
    baseLotExp: 46,
    quoteLotExp: 46,
  },
  "SPX/USD": {
    id: 3,
    base: SPX,
    quote: USD,
    baseLotExp: 34,
    quoteLotExp: 46,
  },
  "BTC/USD": {
    id: 4,
    base: BTC,
    quote: USD,
    baseLotExp: 29,
    quoteLotExp: 46,
  },
} as const;

export const EIP712_TYPES = {
  Initialize: [
    { name: "account", type: "bytes32" },
    { name: "expiry", type: "uint40" },
    { name: "rootKeyType", type: "uint8" },
    { name: "keyType", type: "uint8" },
    { name: "permissions", type: "uint16" },
    { name: "rootPublicKey", type: "bytes" },
    { name: "publicKey", type: "bytes" },
  ],
  Authorize: [
    { name: "account", type: "bytes32" },
    { name: "expiry", type: "uint40" },
    { name: "keyType", type: "uint8" },
    { name: "permissions", type: "uint16" },
    { name: "publicKey", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Revoke: [
    { name: "account", type: "bytes32" },
    { name: "keyId", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  CloseOrder: [
    { name: "orderId", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  ChangeOrder: [
    { name: "orderId", type: "uint64" },
    { name: "price", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  LimitOrder: [
    { name: "quantity", type: "uint256" },
    { name: "instrumentId", type: "uint64" },
    { name: "price", type: "uint64" },
    { name: "bidOrAsk", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  MarketOrder: [
    { name: "quantity", type: "uint256" },
    { name: "minReceivedQuantity", type: "uint256" },
    { name: "instrumentId", type: "uint64" },
    { name: "bidOrAsk", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  AddInstrument: [
    { name: "instrumentId", type: "uint64" },
    { name: "base", type: "address" },
    { name: "quote", type: "address" },
    { name: "baseLotExp", type: "uint8" },
    { name: "quoteLotExp", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Deposit: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Withdrawal: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const EXCHANGE_ABI = [
  {
    type: "constructor",
    inputs: [{ name: "_scheduler", type: "address", internalType: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "execute",
    inputs: [
      {
        name: "batches",
        type: "tuple[]",
        internalType: "struct Batch[]",
        components: [
          {
            name: "mutations",
            type: "uint8[]",
            internalType: "enum Mutation[]",
          },
          { name: "mutationData", type: "bytes[]", internalType: "bytes[]" },
          {
            name: "signatureData",
            type: "bytes[]",
            internalType: "bytes[]",
          },
        ],
      },
      {
        name: "forceExecuteIndexes",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "enqueue",
    inputs: [
      { name: "mutation", type: "uint8", internalType: "enum Mutation" },
      { name: "mutationData", type: "bytes", internalType: "bytes" },
      {
        name: "signatureData",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "forceExecute",
    inputs: [{ name: "index", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "ForceInclusionQueued",
    inputs: [
      { name: "index", type: "uint256", indexed: false },
      { name: "mutation", type: "uint8", indexed: false },
      { name: "mutationData", type: "bytes", indexed: false },
      {
        name: "signatureData",
        type: "bytes",
        indexed: false,
      },
      { name: "enqueuedBlock", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  { type: "error", name: "AlreadyInitialized", inputs: [] },
  { type: "error", name: "AmountNotLotMultiple", inputs: [] },
  {
    type: "error",
    name: "ForceInclusionAlreadyExecuted",
    inputs: [{ name: "index", type: "uint256", internalType: "uint256" }],
  },
  {
    type: "error",
    name: "ForceInclusionTooEarly",
    inputs: [
      { name: "remainingDelay", type: "uint256", internalType: "uint256" },
    ],
  },
  { type: "error", name: "InstrumentAlreadyExists", inputs: [] },
  { type: "error", name: "InsufficientBalance", inputs: [] },
  { type: "error", name: "InvalidAccount", inputs: [] },
  { type: "error", name: "InvalidInstrument", inputs: [] },
  { type: "error", name: "InvalidMutation", inputs: [] },
  { type: "error", name: "InvalidNonce", inputs: [] },
  {
    type: "error",
    name: "InvalidSignature",
    inputs: [{ name: "keyType", type: "uint8", internalType: "enum KeyType" }],
  },
  { type: "error", name: "InvalidTick", inputs: [] },
  { type: "error", name: "KeyExpired", inputs: [] },
  { type: "error", name: "KeyNotFound", inputs: [] },
  { type: "error", name: "LotExpTooLarge", inputs: [] },
  { type: "error", name: "OrderNotFound", inputs: [] },
  { type: "error", name: "SignatureExpired", inputs: [] },
  { type: "error", name: "SlippageExceeded", inputs: [] },
  { type: "error", name: "TickPartiallyFilled", inputs: [] },
  { type: "error", name: "Unauthorized", inputs: [] },
  {
    type: "error",
    name: "UnauthorizedExecute",
    inputs: [{ name: "caller", type: "address", internalType: "address" }],
  },
  {
    type: "error",
    name: "UnknownMutation",
    inputs: [{ name: "mutation", type: "uint8", internalType: "uint8" }],
  },
] as const;

export type InstrumentConfig = {
  id: number;
  base: Address;
  quote: Address;
  baseLotExp: number;
  quoteLotExp: number;
};

const DECIMALS = 18;
const Q32 = 1n << 32n;

export type TokenAmount = {
  raw: bigint;
  human: number;
  asset: Address;
};

export const TokenAmount = {
  from(human: number, asset: Address): TokenAmount {
    const raw = BigInt(Math.round(human * 10 ** DECIMALS));
    return { raw, human, asset };
  },

  fromRaw(raw: bigint, asset: Address): TokenAmount {
    const human = Number(raw) / 10 ** DECIMALS;
    return { raw, human, asset };
  },
};

export function toLots(raw: bigint, lotExp: number): bigint {
  return raw >> BigInt(lotExp);
}

export function fromLots(lots: bigint, lotExp: number): bigint {
  return lots << BigInt(lotExp);
}

/** @dev humanPrice = q32Price * (2^-(32 + baseLotExp - quoteLotExp)) */
export function q32ToPrice(
  q32Price: bigint,
  instrument: InstrumentConfig,
): number {
  const integer = Number(q32Price >> 32n);
  const fractional = Number(q32Price & (Q32 - 1n)) / Number(Q32);
  const priceScaled = integer + fractional;
  const scale = 2 ** (instrument.quoteLotExp - instrument.baseLotExp);
  return priceScaled * scale;
}

/** @dev q32Price = humanPrice * 2^(32 + baseLotExp - quoteLotExp) */
export function priceToQ32(
  price: number,
  instrument: InstrumentConfig,
): bigint {
  const scale = 2 ** (instrument.baseLotExp - instrument.quoteLotExp);
  const priceScaled = price * scale;
  const integer = BigInt(Math.floor(priceScaled));
  const fractional = BigInt(
    Math.round((priceScaled - Number(integer)) * Number(Q32)),
  );
  return (integer << 32n) | fractional;
}

export function baseToQuote(
  quantity: TokenAmount,
  q32Price: bigint,
  instrument: InstrumentConfig,
): TokenAmount {
  const baseLots = toLots(quantity.raw, instrument.baseLotExp);
  const quoteLots = (baseLots * q32Price) >> 32n;
  const raw = quoteLots << BigInt(instrument.quoteLotExp);
  return TokenAmount.fromRaw(raw, instrument.quote);
}

export { EXCHANGE_STORAGE_LAYOUT } from "./storage-layout";
