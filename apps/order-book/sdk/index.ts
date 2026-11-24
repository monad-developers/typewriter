import { Hex, Secp256k1 } from "ox";
import { type Address, fromPublicKey } from "ox/Address";
import type {
  TypewriterManifest,
  TypewriterMutationInput,
  TypewriterSolidityEntrypoint,
} from "typewriter";
import { createSigner, KeyType, packNonce } from "typewriter/client";
import type OrderBook from "../contracts/src/OrderBook.sol";

type OrderBookMetadata =
  typeof OrderBook extends TypewriterSolidityEntrypoint<infer metadata>
    ? metadata
    : never;

export type OrderBookMutations = OrderBookMetadata extends {
  readonly mutations: infer mutations extends TypewriterManifest["mutations"];
}
  ? mutations
  : never;

export type OrderBookManifest = TypewriterManifest<OrderBookMutations>;

export type OrderBookMutation = TypewriterMutationInput<OrderBookMutations>;

export type OrderBookMutationName = keyof OrderBookMutations & string;

export const USD: Address = "0x1111111111111111111111111111111111111111";
export const GOLD: Address = "0x2222222222222222222222222222222222222222";
export const WTIOIL: Address = "0x3333333333333333333333333333333333333333";
export const EUR: Address = "0x4444444444444444444444444444444444444444";
export const SPX: Address = "0x5555555555555555555555555555555555555555";
export const BTC: Address = "0x6666666666666666666666666666666666666666";

export const ASSETS = [USD, GOLD, WTIOIL, EUR, SPX, BTC] as const;

/**
 * The mutations a session key may sign: every app mutation except
 * `Withdrawal`. Pass it as `AddCredential`'s `permissions` when signing.
 */
export const DEFAULT_NON_ROOT_PERMISSIONS = [
  "CloseOrder",
  "ChangeOrder",
  "LimitOrder",
  "MarketOrder",
  "AddInstrument",
  "Deposit",
] as const satisfies readonly OrderBookMutationName[];

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

/** Rounds down to a whole number of lots. The contract rejects the rest. */
export function lotAligned(raw: bigint, lotExp: number): bigint {
  return fromLots(toLots(raw, lotExp), lotExp);
}

export type Side = "buy" | "sell";

export function bidOrAsk(side: Side): 0 | 1 {
  return side === "buy" ? 0 : 1;
}

export function limitOrderParams(
  instrument: InstrumentConfig,
  order: { price: number; side: Side; quantity: TokenAmount },
) {
  return {
    quantity: lotAligned(order.quantity.raw, instrument.baseLotExp),
    instrumentId: BigInt(instrument.id),
    price: priceToQ32(order.price, instrument),
    bidOrAsk: bidOrAsk(order.side),
  };
}

/** A nonce on a random lane, so it doesn't wait on the account's others. */
export function randomNonce(): bigint {
  return packNonce(BigInt(Hex.random(24)), 0n);
}

/** Signs order book mutations with a raw secp256k1 private key. */
export function secp256k1Signer(
  manifest: OrderBookManifest,
  privateKey: Hex.Hex,
) {
  return createSigner(manifest, {
    keyType: KeyType.Secp256k1,
    address: fromPublicKey(Secp256k1.getPublicKey({ privateKey })),
    async sign(payload) {
      return Secp256k1.sign({ payload, privateKey });
    },
  });
}
