import {
  BTC,
  EUR,
  GOLD,
  INSTRUMENTS,
  type InstrumentConfig,
  q32ToPrice,
  SPX,
  TokenAmount,
  USD,
  WTIOIL,
} from "order-book-sdk";
import type { Address } from "viem";
import type { ApiMutation } from "../hooks/useMutations";

const INSTRUMENT_BY_ID = new Map<
  number,
  { name: string; config: InstrumentConfig }
>(
  Object.entries(INSTRUMENTS).map(([name, config]) => [
    config.id,
    { name, config },
  ]),
);

const ASSET_SYMBOLS: Record<Address, string> = {
  [USD]: "USD",
  [GOLD]: "GOLD",
  [WTIOIL]: "WTIOIL",
  [EUR]: "EUR",
  [SPX]: "SPX",
  [BTC]: "BTC",
};

const KEY_TYPE_NAMES = ["p256", "webauthn-p256", "secp256k1"];

function assetSymbol(asset: Address) {
  return ASSET_SYMBOLS[asset] ?? asset;
}

function baseSymbol(instrumentId: number) {
  const entry = INSTRUMENT_BY_ID.get(instrumentId);
  if (entry === undefined) return `#${instrumentId}`;
  return assetSymbol(entry.config.base);
}

function formatBaseQuantity(
  quantity: string | number | bigint | null | undefined,
  instrumentId: number,
) {
  if (quantity === null || quantity === undefined) return "?";
  const entry = INSTRUMENT_BY_ID.get(instrumentId);
  if (entry === undefined) return String(quantity);
  return TokenAmount.fromRaw(BigInt(quantity), entry.config.base).human.toFixed(
    2,
  );
}

function formatPrice(
  priceQ32: string | number | bigint | null | undefined,
  instrumentId: number,
) {
  if (priceQ32 === null || priceQ32 === undefined) return "?";
  const entry = INSTRUMENT_BY_ID.get(instrumentId);
  if (entry === undefined) return String(priceQ32);
  return `$${q32ToPrice(BigInt(priceQ32), entry.config).toFixed(2)}`;
}

function instrumentName(instrumentId: number) {
  return INSTRUMENT_BY_ID.get(instrumentId)?.name ?? `#${instrumentId}`;
}

function keyTypeName(keyType: number) {
  return KEY_TYPE_NAMES[keyType] ?? `keyType ${keyType}`;
}

function hasColumn(mutation: ApiMutation, column: string) {
  return mutation[column] !== undefined && mutation[column] !== null;
}

function asString(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : typeof value === "bigint"
      ? value.toString()
      : undefined;
}

function asNumber(value: unknown) {
  const raw = asString(value);
  return raw === undefined ? undefined : Number(raw);
}

function asAddress(value: unknown) {
  return typeof value === "string" ? (value as Address) : undefined;
}

export function MutationDescription({ mutation }: { mutation: ApiMutation }) {
  if (hasColumn(mutation, "rootKeyType")) {
    return (
      <>
        initialize account with {keyTypeName(asNumber(mutation.keyType) ?? 0)}
        key
      </>
    );
  }

  if (hasColumn(mutation, "keyType") && hasColumn(mutation, "publicKey")) {
    return <>authorize {keyTypeName(asNumber(mutation.keyType) ?? 0)} key</>;
  }

  if (hasColumn(mutation, "keyId")) return <>revoke key</>;

  if (hasColumn(mutation, "asset") && hasColumn(mutation, "amount")) {
    const asset = asAddress(mutation.asset);
    const amount = asString(mutation.amount);
    if (asset !== undefined && amount !== undefined) {
      const formatted = TokenAmount.fromRaw(
        BigInt(amount),
        asset,
      ).human.toFixed(2);
      return (
        <>
          asset movement {formatted} {assetSymbol(asset)}
        </>
      );
    }
    return <>asset movement</>;
  }

  if (hasColumn(mutation, "quantity") && hasColumn(mutation, "price")) {
    const quantity = asString(mutation.quantity);
    const instrumentId = asNumber(mutation.instrumentId);
    const price = asString(mutation.price);
    const bidOrAsk = asNumber(mutation.bidOrAsk);
    if (
      quantity !== undefined &&
      instrumentId !== undefined &&
      price !== undefined
    ) {
      const side = bidOrAsk === 0 ? "buy" : "sell";
      return (
        <>
          limit {side} {formatBaseQuantity(quantity, instrumentId)}{" "}
          {baseSymbol(instrumentId)} @ {formatPrice(price, instrumentId)}
        </>
      );
    }
    return <>limit order</>;
  }

  if (
    hasColumn(mutation, "quantity") &&
    hasColumn(mutation, "minReceivedQuantity")
  ) {
    const quantity = asString(mutation.quantity);
    const instrumentId = asNumber(mutation.instrumentId);
    const bidOrAsk = asNumber(mutation.bidOrAsk);
    if (quantity !== undefined && instrumentId !== undefined) {
      const side = bidOrAsk === 0 ? "buy" : "sell";
      return (
        <>
          market {side} {formatBaseQuantity(quantity, instrumentId)}{" "}
          {baseSymbol(instrumentId)}
        </>
      );
    }
    return <>market order</>;
  }

  if (hasColumn(mutation, "orderId") && hasColumn(mutation, "price")) {
    return (
      <>
        change limit order #{asString(mutation.orderId) ?? "?"} to price{" "}
        {asString(mutation.price) ?? "?"}
      </>
    );
  }

  if (hasColumn(mutation, "orderId")) {
    return <>close limit order #{asString(mutation.orderId) ?? "?"}</>;
  }

  if (hasColumn(mutation, "base") && hasColumn(mutation, "quote")) {
    return (
      <>add {instrumentName(asNumber(mutation.instrumentId) ?? 0)} instrument</>
    );
  }

  return <>mutation #{mutation.id}</>;
}
