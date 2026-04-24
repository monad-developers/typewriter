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

const PLAIN_COLUMNS_LEFT = ["", "inventory", "price", "spread"] as const;
const BID_SUB = ["25bp", "5bp", "1bp"] as const;
const ASK_SUB = ["1bp", "5bp", "25bp"] as const;
const PLAIN_COLUMNS_RIGHT = ["buy", "sell"] as const;

const BID_CELL = "bg-emerald-50/70";
const ASK_CELL = "bg-rose-50/70";
const BID_HEADER = "bg-emerald-100/70 text-emerald-900";
const ASK_HEADER = "bg-rose-100/70 text-rose-900";

const instruments = Object.entries(INSTRUMENTS) as [
  keyof typeof INSTRUMENTS,
  (typeof INSTRUMENTS)[keyof typeof INSTRUMENTS],
][];

export function Exchange() {
  const { account } = useAccountContext();
  const { data: balancesData } = useBalances(account?.accountId);

  return (
    <div className="border border-border rounded-[4px] overflow-hidden bg-background">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th
              colSpan={PLAIN_COLUMNS_LEFT.length}
              className="h-7 border-b border-border"
            />
            <th
              colSpan={BID_SUB.length}
              className={`h-7 text-center align-middle text-[11px] uppercase tracking-[0.18em] font-semibold ${BID_HEADER} border-b border-emerald-200`}
            >
              bid
            </th>
            <th
              colSpan={ASK_SUB.length}
              className={`h-7 text-center align-middle text-[11px] uppercase tracking-[0.18em] font-semibold ${ASK_HEADER} border-b border-rose-200`}
            >
              ask
            </th>
            <th
              colSpan={PLAIN_COLUMNS_RIGHT.length}
              className="h-7 border-b border-border"
            />
          </tr>
          <tr className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            {PLAIN_COLUMNS_LEFT.map((col) => (
              <th
                key={col || "name"}
                className="text-left px-3 h-9 align-middle whitespace-nowrap border-b border-border font-semibold"
              >
                {col}
              </th>
            ))}
            {BID_SUB.map((col) => (
              <th
                key={`bid-${col}`}
                className={`text-left px-3 h-9 align-middle whitespace-nowrap ${BID_HEADER} border-b border-emerald-200 font-semibold`}
              >
                {col}
              </th>
            ))}
            {ASK_SUB.map((col) => (
              <th
                key={`ask-${col}`}
                className={`text-left px-3 h-9 align-middle whitespace-nowrap ${ASK_HEADER} border-b border-rose-200 font-semibold`}
              >
                {col}
              </th>
            ))}
            {PLAIN_COLUMNS_RIGHT.map((col) => (
              <th
                key={col}
                className="text-left px-3 h-9 align-middle whitespace-nowrap border-b border-border font-semibold"
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

  const bidCell = `px-3 h-10 align-middle whitespace-nowrap tabular-nums ${BID_CELL}`;
  const askCell = `px-3 h-10 align-middle whitespace-nowrap tabular-nums ${ASK_CELL}`;

  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="px-3 h-10 align-middle whitespace-nowrap font-semibold">
        {name}
      </td>
      <td className="px-3 h-10 align-middle whitespace-nowrap tabular-nums">
        {balance.toFixed(4)}
      </td>
      <td className="px-3 h-10 align-middle whitespace-nowrap tabular-nums">
        {price}
      </td>
      <td className="px-3 h-10 align-middle whitespace-nowrap tabular-nums text-muted-foreground">
        {spread}
      </td>
      <td className={bidCell}>{fmtDepth("bids", "25")}</td>
      <td className={bidCell}>{fmtDepth("bids", "5")}</td>
      <td className={bidCell}>{fmtDepth("bids", "1")}</td>
      <td className={askCell}>{fmtDepth("asks", "1")}</td>
      <td className={askCell}>{fmtDepth("asks", "5")}</td>
      <td className={askCell}>{fmtDepth("asks", "25")}</td>
      <td className="px-3 h-10 align-middle whitespace-nowrap">
        <OrderInput
          value={buyAmount}
          onChange={setBuyAmount}
          onSubmit={() => submit("buy", buyAmount)}
          disabled={marketOrder.isPending}
        />
      </td>
      <td className="px-3 h-10 align-middle whitespace-nowrap">
        <OrderInput
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
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
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
      className="w-20 h-7 px-2 font-mono text-sm tabular-nums rounded-[3px] border border-border bg-background placeholder:text-muted-foreground focus:outline-none focus:border-foreground/50 disabled:opacity-50"
    />
  );
}
