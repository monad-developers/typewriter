import type { Address } from "ox/Address";

export const USD: Address = "0x1111111111111111111111111111111111111111";
export const GOLD: Address = "0x2222222222222222222222222222222222222222";
export const WTIOIL: Address = "0x3333333333333333333333333333333333333333";
export const EUR: Address = "0x4444444444444444444444444444444444444444";
export const SPX: Address = "0x5555555555555555555555555555555555555555";
export const BTC: Address = "0x6666666666666666666666666666666666666666";

export const ASSETS = [USD, GOLD, WTIOIL, EUR, SPX, BTC] as const;

export const PERM_CLOSE_ORDER = 1 << 0;
export const PERM_CHANGE_ORDER = 1 << 1;
export const PERM_LIMIT_ORDER = 1 << 2;
export const PERM_MARKET_ORDER = 1 << 3;
export const PERM_ADD_INSTRUMENT = 1 << 4;
export const PERM_DEPOSIT = 1 << 5;
export const PERM_WITHDRAW = 1 << 6;

export const ALL_PERMISSIONS =
  PERM_CLOSE_ORDER |
  PERM_CHANGE_ORDER |
  PERM_LIMIT_ORDER |
  PERM_MARKET_ORDER |
  PERM_ADD_INSTRUMENT |
  PERM_DEPOSIT |
  PERM_WITHDRAW;

export const DEFAULT_NON_ROOT_PERMISSIONS = ALL_PERMISSIONS & ~PERM_WITHDRAW;

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
