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

function keyTypeName(keyType: number) {
  return KEY_TYPE_NAMES[keyType] ?? `keyType ${keyType}`;
}

function assetSymbol(asset: Address) {
  return ASSET_SYMBOLS[asset] ?? asset;
}

function instrumentEntry(instrumentId: number) {
  return INSTRUMENT_BY_ID.get(instrumentId);
}

function formatBaseQuantity(quantity: string, instrumentId: number) {
  const entry = instrumentEntry(instrumentId);
  if (!entry) return quantity;
  const amount = TokenAmount.fromRaw(
    BigInt(quantity),
    entry.config.base,
  ).human.toFixed(2);
  return `${amount} ${assetSymbol(entry.config.base)}`;
}

function formatPrice(priceQ32: string, instrumentId: number) {
  const entry = instrumentEntry(instrumentId);
  if (!entry) return priceQ32;
  return `$${q32ToPrice(BigInt(priceQ32), entry.config).toFixed(2)}`;
}

function formatAmount(amount: string, asset: Address) {
  return TokenAmount.fromRaw(BigInt(amount), asset).human.toFixed(2);
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <code className="break-all">
      {label}: {value}
    </code>
  );
}

export function MutationParams({ mutation }: { mutation: ApiMutation }) {
  return <>{renderRows(mutation)}</>;
}

function renderRows(mutation: ApiMutation) {
  if (mutation.payload == null) {
    return <Row label="payload" value="pending" />;
  }
  switch (mutation.type) {
    case "initialize":
      return (
        <>
          <Row label="expiry" value={mutation.payload.expiry || "no expiry"} />
          <Row
            label="root key type"
            value={keyTypeName(mutation.payload.rootKeyType)}
          />
          <Row label="key type" value={keyTypeName(mutation.payload.keyType)} />
          <Row
            label="permissions"
            value={`0b${mutation.payload.permissions.toString(2).padStart(8, "0")}`}
          />
          <Row label="root public key" value={mutation.payload.rootPublicKey} />
          <Row label="public key" value={mutation.payload.publicKey} />
        </>
      );
    case "authorize":
      return (
        <>
          <Row label="expiry" value={mutation.payload.expiry || "no expiry"} />
          <Row label="key type" value={keyTypeName(mutation.payload.keyType)} />
          <Row
            label="permissions"
            value={`0b${mutation.payload.permissions.toString(2).padStart(8, "0")}`}
          />
          <Row label="public key" value={mutation.payload.publicKey} />
        </>
      );
    case "revoke":
      return <Row label="revoked key id" value={mutation.payload.revokedKeyId} />;
    case "closeOrder":
      return <Row label="order id" value={mutation.payload.orderId} />;
    case "limitOrder": {
      const id = Number(mutation.payload.instrumentId);
      return (
        <>
          <Row
            label="instrument"
            value={instrumentEntry(id)?.name ?? `#${id}`}
          />
          <Row
            label="side"
            value={mutation.payload.bidOrAsk === 0 ? "buy" : "sell"}
          />
          <Row
            label="quantity"
            value={formatBaseQuantity(mutation.payload.quantity, id)}
          />
          <Row
            label="price"
            value={formatPrice(mutation.payload.price, id)}
          />
        </>
      );
    }
    case "marketOrder": {
      const id = Number(mutation.payload.instrumentId);
      const entry = instrumentEntry(id);
      const receivedAsset =
        entry &&
        (mutation.payload.bidOrAsk === 0
          ? entry.config.base
          : entry.config.quote);
      return (
        <>
          <Row
            label="instrument"
            value={instrumentEntry(id)?.name ?? `#${id}`}
          />
          <Row
            label="side"
            value={mutation.payload.bidOrAsk === 0 ? "buy" : "sell"}
          />
          <Row
            label="quantity"
            value={formatBaseQuantity(mutation.payload.quantity, id)}
          />
          <Row
            label="min received"
            value={
              receivedAsset
                ? formatAmount(mutation.payload.minReceivedQuantity, receivedAsset)
                : mutation.payload.minReceivedQuantity
            }
          />
        </>
      );
    }
    case "addInstrument":
      return (
        <>
          <Row label="instrument id" value={mutation.payload.instrumentId} />
          <Row label="base" value={assetSymbol(mutation.payload.base)} />
          <Row label="quote" value={assetSymbol(mutation.payload.quote)} />
          <Row label="base lot exp" value={mutation.payload.baseLotExp} />
          <Row label="quote lot exp" value={mutation.payload.quoteLotExp} />
        </>
      );
    case "deposit":
      return (
        <>
          <Row label="asset" value={assetSymbol(mutation.payload.asset)} />
          <Row
            label="amount"
            value={formatAmount(mutation.payload.amount, mutation.payload.asset)}
          />
        </>
      );
    case "withdrawal":
      return (
        <>
          <Row label="asset" value={assetSymbol(mutation.payload.asset)} />
          <Row
            label="amount"
            value={formatAmount(mutation.payload.amount, mutation.payload.asset)}
          />
        </>
      );
  }
}

export function MarketOrderFills({
  mutation,
}: {
  mutation: Extract<ApiMutation, { type: "marketOrder" }>;
}) {
  if (mutation.payload == null)
    return <code className="text-muted-foreground">Pending</code>;
  const id = Number(mutation.payload.instrumentId);
  const entry = instrumentEntry(id);
  const fills = mutation.payload.fills;
  if (fills.length === 0)
    return <code className="text-muted-foreground">No fills</code>;

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b">
          <th className="text-left py-2 pr-6">
            <code>quantity</code>
          </th>
          <th className="text-left py-2 pr-6">
            <code>price</code>
          </th>
        </tr>
      </thead>
      <tbody>
        {fills.map((f, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fill position is the identity
          <tr key={i} className="border-b last:border-0">
            <td className="py-2 pr-6">
              <code>
                {entry
                  ? `${TokenAmount.fromRaw(
                      BigInt(f.quantity) << BigInt(entry.config.baseLotExp),
                      entry.config.base,
                    ).human.toFixed(2)} ${assetSymbol(entry.config.base)}`
                  : f.quantity}
              </code>
            </td>
            <td className="py-2 pr-6">
              <code>{formatPrice(f.price, id)}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
