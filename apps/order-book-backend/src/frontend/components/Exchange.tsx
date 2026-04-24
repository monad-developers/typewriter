import { fromLots, INSTRUMENTS, q32ToPrice, TokenAmount } from "order-book-sdk";
import { useState } from "react";
import { useAccountContext } from "../contexts/AccountContext";
import { useBalances } from "../hooks/useBalances";
import { useDepth } from "../hooks/useDepth";
import { useMarketOrderMutation } from "../hooks/useMarketOrderMutation";
import { usePrice } from "../hooks/usePrice";

function lotAligned(raw: bigint, lotExp: number): bigint {
  const e = BigInt(lotExp);
  return (raw >> e) << e;
}

const PLAIN_COLUMNS_LEFT = [
  { key: "name", label: "" },
  { key: "inventory", label: "inventory" },
  { key: "price", label: "price" },
  { key: "spread", label: "spread" },
] as const;
const BID_SUB = ["25bp", "5bp", "1bp"] as const;
const ASK_SUB = ["1bp", "5bp", "25bp"] as const;
const PLAIN_COLUMNS_RIGHT = ["buy", "sell"] as const;

const BID_CELL = "bg-emerald-50";
const ASK_CELL = "bg-rose-50";
const BID_HEADER = "bg-emerald-100/80 text-emerald-900";
const ASK_HEADER = "bg-rose-100/80 text-rose-900";

const instruments = Object.entries(INSTRUMENTS) as [
  keyof typeof INSTRUMENTS,
  (typeof INSTRUMENTS)[keyof typeof INSTRUMENTS],
][];

export function Exchange() {
  const { account } = useAccountContext();
  const { data: balancesData } = useBalances(account?.accountId);

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-background shadow-sm">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th
              colSpan={PLAIN_COLUMNS_LEFT.length}
              className="h-6 border-b border-border"
            />
            <th
              colSpan={BID_SUB.length}
              className={`h-6 text-center align-middle text-[10px] uppercase tracking-[0.22em] font-bold ${BID_HEADER} border-b border-emerald-300`}
            >
              Bid
            </th>
            <th
              colSpan={ASK_SUB.length}
              className={`h-6 text-center align-middle text-[10px] uppercase tracking-[0.22em] font-bold ${ASK_HEADER} border-b border-rose-300`}
            >
              Ask
            </th>
            <th
              colSpan={PLAIN_COLUMNS_RIGHT.length}
              className="h-6 border-b border-border"
            />
          </tr>
          <tr className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground bg-muted/40">
            {PLAIN_COLUMNS_LEFT.map((col) => (
              <th
                key={col.key}
                className="text-left px-3 h-8 align-middle whitespace-nowrap font-bold border-b border-border"
              >
                {col.label}
              </th>
            ))}
            {BID_SUB.map((col) => (
              <th
                key={`bid-${col}`}
                className={`text-left px-3 h-8 align-middle whitespace-nowrap ${BID_HEADER} border-b border-emerald-300 font-bold`}
              >
                {col}
              </th>
            ))}
            {ASK_SUB.map((col) => (
              <th
                key={`ask-${col}`}
                className={`text-left px-3 h-8 align-middle whitespace-nowrap ${ASK_HEADER} border-b border-rose-300 font-bold`}
              >
                {col}
              </th>
            ))}
            {PLAIN_COLUMNS_RIGHT.map((col) => (
              <th
                key={col}
                className="text-left px-3 h-8 align-middle whitespace-nowrap font-bold border-b border-border"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {instruments.map(([name, inst]) => (
            <Row
              key={name}
              name={name}
              instrument={inst}
              balance={
                TokenAmount.fromRaw(
                  BigInt(balancesData?.balances[inst.base] ?? "0"),
                  inst.base,
                ).human
              }
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  name,
  instrument,
  balance,
}: {
  name: string;
  instrument: (typeof INSTRUMENTS)[keyof typeof INSTRUMENTS];
  balance: number;
}) {
  const { data: priceData } = usePrice(instrument.id);
  const { data: depthData } = useDepth(instrument.id);
  const marketOrder = useMarketOrderMutation();
  const [buyAmount, setBuyAmount] = useState("");
  const [sellAmount, setSellAmount] = useState("");

  const submit = (side: "buy" | "sell", human: string) => {
    const n = Number(human);
    if (!Number.isFinite(n) || n <= 0) return;
    const raw = TokenAmount.from(n, instrument.base).raw;
    const aligned = lotAligned(raw, instrument.baseLotExp);
    if (aligned <= 0n) return;
    marketOrder.mutate(
      {
        instrumentId: instrument.id,
        side,
        amount: aligned.toString(),
      },
      {
        onSuccess: () => {
          if (side === "buy") setBuyAmount("");
          else setSellAmount("");
        },
      },
    );
  };
  const price =
    priceData?.price != null
      ? `$${q32ToPrice(BigInt(priceData.price), instrument).toFixed(2)}`
      : "—";
  const spread =
    priceData?.spread != null
      ? `$${q32ToPrice(BigInt(priceData.spread), instrument).toFixed(2)}`
      : "—";

  const fmtDepth = (side: "bids" | "asks", bp: string) => {
    const lots = depthData?.[side][bp];
    if (lots == null) return "—";
    const raw = fromLots(BigInt(lots), instrument.baseLotExp);
    return TokenAmount.fromRaw(raw, instrument.base).human.toFixed(2);
  };

  const cellBase = "px-3 h-9 align-middle whitespace-nowrap font-mono tabular-nums text-[13px]";

  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-muted/20 transition-colors">
      <td className="px-3 h-9 align-middle whitespace-nowrap font-semibold text-sm">
        {name}
      </td>
      <td className={cellBase}>{balance.toFixed(4)}</td>
      <td className={`${cellBase} font-medium`}>{price}</td>
      <td className={`${cellBase} text-muted-foreground`}>{spread}</td>
      <td className={`${cellBase} ${BID_CELL}`}>{fmtDepth("bids", "25")}</td>
      <td className={`${cellBase} ${BID_CELL}`}>{fmtDepth("bids", "5")}</td>
      <td className={`${cellBase} ${BID_CELL} font-semibold text-emerald-900`}>
        {fmtDepth("bids", "1")}
      </td>
      <td className={`${cellBase} ${ASK_CELL} font-semibold text-rose-900`}>
        {fmtDepth("asks", "1")}
      </td>
      <td className={`${cellBase} ${ASK_CELL}`}>{fmtDepth("asks", "5")}</td>
      <td className={`${cellBase} ${ASK_CELL}`}>{fmtDepth("asks", "25")}</td>
      <td className="px-3 h-9 align-middle whitespace-nowrap">
        <OrderInput
          side="buy"
          value={buyAmount}
          onChange={setBuyAmount}
          onSubmit={() => submit("buy", buyAmount)}
          disabled={marketOrder.isPending}
        />
      </td>
      <td className="px-3 h-9 align-middle whitespace-nowrap">
        <OrderInput
          side="sell"
          value={sellAmount}
          onChange={setSellAmount}
          onSubmit={() => submit("sell", sellAmount)}
          disabled={marketOrder.isPending}
        />
      </td>
    </tr>
  );
}

function OrderInput({
  side,
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  side: "buy" | "sell";
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
  const ring =
    side === "buy"
      ? "focus:border-emerald-400 focus:ring-emerald-100"
      : "focus:border-rose-400 focus:ring-rose-100";
  return (
    <input
      type="number"
      min={0}
      placeholder="0"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit();
      }}
      disabled={disabled}
      className={`w-20 h-7 px-2 font-mono tabular-nums text-[13px] rounded-md border border-border bg-background placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 ${ring} disabled:opacity-50 transition-colors`}
    />
  );
}
