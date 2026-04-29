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
import type {
  AddInstrumentPayload,
  AuthorizePayload,
  CloseOrderPayload,
  DepositPayload,
  InitializePayload,
  LimitOrderPayload,
  MarketOrderPayload,
  RevokePayload,
  WithdrawalPayload,
} from "../hooks/useMutations";

type MutationDescriptor =
  | { type: "initialize"; payload: InitializePayload | null }
  | { type: "authorize"; payload: AuthorizePayload | null }
  | { type: "revoke"; payload: RevokePayload | null }
  | { type: "closeOrder"; payload: CloseOrderPayload | null }
  | { type: "limitOrder"; payload: LimitOrderPayload | null }
  | { type: "marketOrder"; payload: MarketOrderPayload | null }
  | { type: "addInstrument"; payload: AddInstrumentPayload | null }
  | { type: "deposit"; payload: DepositPayload | null }
  | { type: "withdrawal"; payload: WithdrawalPayload | null };

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

function assetSymbol(asset: Address) {
  return ASSET_SYMBOLS[asset] ?? asset;
}

function baseSymbol(instrumentId: number) {
  const entry = INSTRUMENT_BY_ID.get(instrumentId);
  if (!entry) return `#${instrumentId}`;
  return assetSymbol(entry.config.base);
}

function formatBaseQuantity(
  quantity: string | number | bigint | null | undefined,
  instrumentId: number,
) {
  if (quantity == null) return "?";
  const entry = INSTRUMENT_BY_ID.get(instrumentId);
  if (!entry) return String(quantity);
  return TokenAmount.fromRaw(
    BigInt(quantity),
    entry.config.base,
  ).human.toFixed(2);
}

function formatPrice(
  priceQ32: string | number | bigint | null | undefined,
  instrumentId: number,
) {
  if (priceQ32 == null) return "?";
  const entry = INSTRUMENT_BY_ID.get(instrumentId);
  if (!entry) return String(priceQ32);
  return `$${q32ToPrice(BigInt(priceQ32), entry.config).toFixed(2)}`;
}

function instrumentName(instrumentId: number) {
  return INSTRUMENT_BY_ID.get(instrumentId)?.name ?? `#${instrumentId}`;
}

const KEY_TYPE_NAMES = ["p256", "webauthn-p256", "secp256k1"];

function keyTypeName(keyType: number) {
  return KEY_TYPE_NAMES[keyType] ?? `keyType ${keyType}`;
}

export function MutationDescription({
  mutation,
}: {
  mutation: MutationDescriptor;
}) {
  if (mutation.payload == null) return <>{mutation.type}</>;
  switch (mutation.type) {
    case "initialize":
      return (
        <>initialize account with {keyTypeName(mutation.payload.keyType)} key</>
      );
    case "authorize":
      return <>authorize {keyTypeName(mutation.payload.keyType)} key</>;
    case "revoke":
      return <>revoke key</>;
    case "deposit": {
      const amount = TokenAmount.fromRaw(
        BigInt(mutation.payload.amount),
        mutation.payload.asset,
      ).human.toFixed(2);
      return (
        <>
          deposit {amount} {assetSymbol(mutation.payload.asset)}
        </>
      );
    }
    case "withdrawal": {
      const amount = TokenAmount.fromRaw(
        BigInt(mutation.payload.amount),
        mutation.payload.asset,
      ).human.toFixed(2);
      return (
        <>
          withdraw {amount} {assetSymbol(mutation.payload.asset)}
        </>
      );
    }
    case "limitOrder": {
      const { quantity, instrumentId, price, bidOrAsk } = mutation.payload;
      const id = Number(instrumentId);
      const side = bidOrAsk === 0 ? "buy" : "sell";
      return (
        <>
          limit {side} {formatBaseQuantity(quantity, id)} {baseSymbol(id)} @{" "}
          {formatPrice(price, id)}
        </>
      );
    }
    case "marketOrder": {
      const { quantity, instrumentId, bidOrAsk } = mutation.payload;
      const id = Number(instrumentId);
      const side = bidOrAsk === 0 ? "buy" : "sell";
      return (
        <>
          market {side} {formatBaseQuantity(quantity, id)} {baseSymbol(id)}
        </>
      );
    }
    case "closeOrder":
      return <>close limit order #{mutation.payload.orderId}</>;
    case "addInstrument":
      return (
        <>
          add {instrumentName(Number(mutation.payload.instrumentId))} instrument
        </>
      );
  }
}
