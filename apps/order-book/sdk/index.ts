import { AbiParameters, Hex, Secp256k1, Signature } from "ox";
import { type Address, fromPublicKey } from "ox/Address";
import type {
  TypewriterManifest,
  TypewriterMutationInput,
  TypewriterSolidityEntrypoint,
} from "typewriter";
import {
  authorizeMutation,
  deriveAccountID,
  getAuthorizationPayload,
  KeyType,
  packNonce,
  packSecp256k1Signature,
  type TypedMutation,
} from "typewriter/client";
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

export function authorizeWithSecp256k1<
  const name extends OrderBookMutationName,
>(
  manifest: OrderBookManifest,
  privateKey: Hex.Hex,
  mutation: TypedMutation<OrderBookManifest, name>,
) {
  const signature = Secp256k1.sign({
    payload: getAuthorizationPayload(manifest, mutation),
    privateKey,
  });
  return authorizeMutation(
    mutation,
    packSecp256k1Signature(Signature.toHex(signature)),
  );
}

/** The account a secp256k1 root key creates, and its `CreateAccount`. */
export function createSecp256k1Account(
  manifest: OrderBookManifest,
  privateKey: Hex.Hex,
) {
  const params = {
    keyType: KeyType.Secp256k1,
    publicKey: AbiParameters.encode(
      [{ type: "address" }],
      [fromPublicKey(Secp256k1.getPublicKey({ privateKey }))],
    ),
  };
  const accountID = deriveAccountID(params);
  const mutation = authorizeWithSecp256k1(manifest, privateKey, {
    name: "CreateAccount",
    params,
    accountID,
    credentialID: 0n,
    nonce: 0n,
    expiration: 0n,
  });
  return { accountID, mutation };
}
