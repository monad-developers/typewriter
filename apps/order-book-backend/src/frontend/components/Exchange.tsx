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

const BID_SUB = ["25bp", "5bp", "1bp"] as const;
const ASK_SUB = ["1bp", "5bp", "25bp"] as const;

const BID_CELL = "bg-emerald-50/40";
const ASK_CELL = "bg-rose-50/40";

const instruments = Object.entries(INSTRUMENTS) as [
  keyof typeof INSTRUMENTS,
  (typeof INSTRUMENTS)[keyof typeof INSTRUMENTS],
][];

export function Exchange() {
  const { account } = useAccountContext();
  const { data: balancesData } = useBalances(account?.accountId);

  return (
    <div className="border border-border rounded-2xl overflow-hidden bg-background">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th colSpan={4} className="h-10 border-b border-border" />
            <th
              colSpan={BID_SUB.length}
              className="h-10 text-center align-middle text-xs font-medium text-emerald-700 bg-emerald-50/60 border-b border-emerald-100"
            >
              Bids
            </th>
            <th
              colSpan={ASK_SUB.length}
              className="h-10 text-center align-middle text-xs font-medium text-rose-700 bg-rose-50/60 border-b border-rose-100"
            >
              Asks
            </th>
            <th colSpan={2} className="h-10 border-b border-border" />
          </tr>
          <tr className="text-xs text-muted-foreground">
            <Th className="border-b border-border" />
            <Th className="border-b border-border">Inventory</Th>
            <Th className="border-b border-border">Price</Th>
            <Th className="border-b border-border">Spread</Th>
            {BID_SUB.map((col) => (
              <Th
                key={`bid-${col}`}
                className="border-b border-emerald-100 bg-emerald-50/60 text-emerald-700"
              >
                {col}
              </Th>
            ))}
            {ASK_SUB.map((col) => (
              <Th
                key={`ask-${col}`}
                className="border-b border-rose-100 bg-rose-50/60 text-rose-700"
              >
                {col}
              </Th>
            ))}
            <Th className="border-b border-border">Buy</Th>
            <Th className="border-b border-border">Sell</Th>
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

function Th({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`text-left px-4 h-9 align-middle whitespace-nowrap font-medium ${className ?? ""}`}
    >
      {children}
    </th>
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

  const cellBase =
    "px-4 h-14 align-middle whitespace-nowrap font-mono tabular-nums text-sm";

  return (
    <tr className="border-b border-border last:border-b-0 group">
      <td className="px-4 h-14 align-middle whitespace-nowrap">
        <span className="font-semibold text-[15px]">{name}</span>
      </td>
      <td className={`${cellBase} text-muted-foreground`}>
        {balance.toFixed(4)}
      </td>
      <td className={`${cellBase} text-[15px] font-medium`}>{price}</td>
      <td className={`${cellBase} text-muted-foreground`}>{spread}</td>
      <td className={`${cellBase} ${BID_CELL} text-emerald-800/80`}>
        {fmtDepth("bids", "25")}
      </td>
      <td className={`${cellBase} ${BID_CELL} text-emerald-800/80`}>
        {fmtDepth("bids", "5")}
      </td>
      <td className={`${cellBase} ${BID_CELL} text-emerald-700 font-semibold`}>
        {fmtDepth("bids", "1")}
      </td>
      <td className={`${cellBase} ${ASK_CELL} text-rose-700 font-semibold`}>
        {fmtDepth("asks", "1")}
      </td>
      <td className={`${cellBase} ${ASK_CELL} text-rose-800/80`}>
        {fmtDepth("asks", "5")}
      </td>
      <td className={`${cellBase} ${ASK_CELL} text-rose-800/80`}>
        {fmtDepth("asks", "25")}
      </td>
      <td className="px-4 h-14 align-middle whitespace-nowrap">
        <OrderInput
          side="buy"
          value={buyAmount}
          onChange={setBuyAmount}
          onSubmit={() => submit("buy", buyAmount)}
          disabled={marketOrder.isPending}
        />
      </td>
      <td className="px-4 h-14 align-middle whitespace-nowrap">
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
      className={`w-24 h-9 px-3 font-mono tabular-nums text-sm rounded-lg border border-border bg-background placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 ${ring} disabled:opacity-50 transition-colors`}
    />
  );
}
