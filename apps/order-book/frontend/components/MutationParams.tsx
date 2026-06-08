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

const PARAM_EXCLUDES = new Set([
  "id",
  "executionIndex",
  "blockNumber",
  "blockHash",
  "blockTimestamp",
  "transactionHash",
  "status",
  "acceptedAt",
  "includedAt",
  "safeAt",
  "finalizedAt",
  "signature_account",
  "signature_keyId",
  "signature_rawSignature",
  "resolution_fills",
]);

function assetSymbol(asset: Address) {
  return ASSET_SYMBOLS[asset] ?? asset;
}

function instrumentEntry(instrumentId: number) {
  return INSTRUMENT_BY_ID.get(instrumentId);
}

function formatPrice(priceQ32: string | number | bigint, instrumentId: number) {
  const entry = instrumentEntry(instrumentId);
  if (entry === undefined) return String(priceQ32);
  return `$${q32ToPrice(BigInt(priceQ32), entry.config).toFixed(2)}`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <code className="break-all">
      {label}: {value}
    </code>
  );
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value))
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") {
    return JSON.stringify(value, (_, item) =>
      typeof item === "bigint" ? item.toString() : item,
    );
  }
  return String(value);
}

function formatParam(label: string, value: unknown, mutation: ApiMutation) {
  if (label === "asset" || label === "base" || label === "quote") {
    return typeof value === "string"
      ? assetSymbol(value as Address)
      : formatValue(value);
  }
  if (label === "instrumentId") {
    const id = Number(value);
    return instrumentEntry(id)?.name ?? formatValue(value);
  }
  if (label === "price" && mutation.instrumentId !== undefined) {
    return formatPrice(
      value as string | number | bigint,
      Number(mutation.instrumentId),
    );
  }
  if (label === "bidOrAsk") return Number(value) === 0 ? "buy" : "sell";
  return formatValue(value);
}

export function MutationParams({ mutation }: { mutation: ApiMutation }) {
  const rows = Object.entries(mutation).filter(
    ([key, value]) => !PARAM_EXCLUDES.has(key) && value !== undefined,
  );

  if (rows.length === 0) return <Row label="params" value="none" />;

  return (
    <>
      {rows.map(([key, value]) => (
        <Row key={key} label={key} value={formatParam(key, value, mutation)} />
      ))}
    </>
  );
}

function isFill(
  value: unknown,
): value is { quantity: unknown; price: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    "quantity" in value &&
    "price" in value
  );
}

export function MarketOrderFills({ mutation }: { mutation: ApiMutation }) {
  const fills = Array.isArray(mutation.resolution_fills)
    ? mutation.resolution_fills.filter(isFill)
    : [];
  if (fills.length === 0)
    return <code className="text-muted-foreground">No fills</code>;

  const instrumentId = Number(mutation.instrumentId);
  const entry = instrumentEntry(instrumentId);

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
        {fills.map((fill, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fill position is the identity
          <tr key={i} className="border-b last:border-0">
            <td className="py-2 pr-6">
              <code>
                {entry
                  ? `${TokenAmount.fromRaw(
                      BigInt(formatValue(fill.quantity)) <<
                        BigInt(entry.config.baseLotExp),
                      entry.config.base,
                    ).human.toFixed(2)} ${assetSymbol(entry.config.base)}`
                  : formatValue(fill.quantity)}
              </code>
            </td>
            <td className="py-2 pr-6">
              <code>{formatPrice(formatValue(fill.price), instrumentId)}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
