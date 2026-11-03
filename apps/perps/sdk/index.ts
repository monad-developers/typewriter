import { AbiParameters, Hex, Secp256k1, Signature } from "ox";
import { fromPublicKey } from "ox/Address";
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
import type Perps from "../contracts/src/Perps.sol";

type PerpsMetadata =
  typeof Perps extends TypewriterSolidityEntrypoint<infer metadata>
    ? metadata
    : never;

export type PerpsMutations = PerpsMetadata extends {
  readonly mutations: infer mutations extends TypewriterManifest["mutations"];
}
  ? mutations
  : never;

export type PerpsManifest = TypewriterManifest<PerpsMutations>;

export type PerpsMutation = TypewriterMutationInput<PerpsMutations>;

export type PerpsMutationName = keyof PerpsMutations & string;

export type PerpsParams<name extends PerpsMutationName> = TypedMutation<
  PerpsManifest,
  name
>["params"];

/** Collateral is a 6-decimal dollar. */
export const COLLATERAL_DECIMALS = 6;

export const Side = { Buy: 0, Sell: 1 } as const;
export type Side = "buy" | "sell";

export const MarketStatus = { Active: 0, ReduceOnly: 1, Halted: 2 } as const;

export type MarketConfig = {
  id: number;
  /** Base units in one lot. Sizes onchain are whole lots. */
  lotSize: number;
  /** The smallest price step, in collateral units per lot. */
  tickSize: bigint;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  takerFeeBps: number;
  liquidationFeeBps: number;
  /** The dev oracle's starting price, in dollars per base unit. */
  initialPrice: number;
};

export const MARKETS = {
  "BTC-PERP": {
    id: 0,
    lotSize: 0.0001,
    tickSize: 100n,
    initialMarginBps: 1_000,
    maintenanceMarginBps: 500,
    takerFeeBps: 5,
    liquidationFeeBps: 50,
    initialPrice: 77_300,
  },
  "ETH-PERP": {
    id: 1,
    lotSize: 0.001,
    tickSize: 100n,
    initialMarginBps: 1_000,
    maintenanceMarginBps: 500,
    takerFeeBps: 5,
    liquidationFeeBps: 50,
    initialPrice: 3_500,
  },
  "SOL-PERP": {
    id: 2,
    lotSize: 0.01,
    tickSize: 10n,
    initialMarginBps: 2_000,
    maintenanceMarginBps: 1_000,
    takerFeeBps: 5,
    liquidationFeeBps: 50,
    initialPrice: 180,
  },
} as const satisfies Record<string, MarketConfig>;

export type MarketName = keyof typeof MARKETS;

export function marketById(id: number | bigint): MarketConfig | undefined {
  return Object.values(MARKETS).find((market) => market.id === Number(id));
}

export function dollars(amount: number): bigint {
  return BigInt(Math.round(amount * 10 ** COLLATERAL_DECIMALS));
}

export function toDollars(amount: bigint): number {
  return Number(amount) / 10 ** COLLATERAL_DECIMALS;
}

/** Collateral units per lot for a dollar price per base unit, on a tick. */
export function lotPrice(price: number, market: MarketConfig): bigint {
  const raw = dollars(price * market.lotSize);
  return (raw / market.tickSize) * market.tickSize;
}

export function toPrice(lotPrice: bigint, market: MarketConfig): number {
  return toDollars(lotPrice) / market.lotSize;
}

export function toLots(size: number, market: MarketConfig): bigint {
  return BigInt(Math.round(size / market.lotSize));
}

export function sideId(side: Side): 0 | 1 {
  return side === "buy" ? Side.Buy : Side.Sell;
}

/** A nonce on a random lane, so it doesn't wait on the account's others. */
export function randomNonce(): bigint {
  return packNonce(BigInt(Hex.random(24)), 0n);
}

export function authorizeWithSecp256k1<const name extends PerpsMutationName>(
  manifest: PerpsManifest,
  privateKey: Hex.Hex,
  mutation: TypedMutation<PerpsManifest, name>,
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
  manifest: PerpsManifest,
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

/** Signs every mutation as one secp256k1 account, each on a fresh lane. */
export function secp256k1Signer(manifest: PerpsManifest, privateKey: Hex.Hex) {
  const { accountID, mutation: createAccount } = createSecp256k1Account(
    manifest,
    privateKey,
  );
  const sign = <const name extends PerpsMutationName>(
    name: name,
    params: PerpsParams<name>,
  ) =>
    authorizeWithSecp256k1(manifest, privateKey, {
      name,
      params,
      accountID,
      credentialID: 0n,
      nonce: randomNonce(),
      expiration: 0n,
    });
  return { accountID, createAccount, sign };
}
