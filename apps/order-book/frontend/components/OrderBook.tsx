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

const BID_CELL = "bg-green-50";
const ASK_CELL = "bg-red-50";
const BID_HEADER = "bg-green-100 text-green-900";
const ASK_HEADER = "bg-red-100 text-red-900";
const BID_TOP = "border-t-2 border-green-400";
const ASK_TOP = "border-t-2 border-red-400";
const BID_GROUP_FIRST = "border-l-2 border-green-400";
const BID_GROUP_LAST = "border-r-2 border-green-400";
const ASK_GROUP_FIRST = "border-l-2 border-red-400";
const ASK_GROUP_LAST = "border-r-2 border-red-400";

const instruments = Object.entries(INSTRUMENTS) as [
  keyof typeof INSTRUMENTS,
  (typeof INSTRUMENTS)[keyof typeof INSTRUMENTS],
][];

export function OrderBook() {
  const { account } = useAccountContext();
  const { data: balancesData } = useBalances(account?.accountId);

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="h-8">
          {PLAIN_COLUMNS_LEFT.map((col) => (
            <th key={col || "name"} className="px-3" />
          ))}
          <th
            colSpan={BID_SUB.length}
            className={`text-center px-3 align-middle whitespace-nowrap ${BID_HEADER} ${BID_TOP} ${BID_GROUP_FIRST} ${BID_GROUP_LAST}`}
          >
            <code>bid</code>
          </th>
          <th
            colSpan={ASK_SUB.length}
            className={`text-center px-3 align-middle whitespace-nowrap ${ASK_HEADER} ${ASK_TOP} ${ASK_GROUP_FIRST} ${ASK_GROUP_LAST}`}
          >
            <code>ask</code>
          </th>
          {PLAIN_COLUMNS_RIGHT.map((col) => (
            <th key={col} className="px-3" />
          ))}
        </tr>
        <tr className="h-10">
          {PLAIN_COLUMNS_LEFT.map((col) => (
            <th
              key={col || "name"}
              className="text-left px-3 align-middle whitespace-nowrap border-b"
            >
              <code>{col}</code>
            </th>
          ))}
          {BID_SUB.map((col, i) => (
            <th
              key={`bid-${col}`}
              className={`text-left px-3 align-middle whitespace-nowrap ${BID_HEADER} ${
                i === 0 ? BID_GROUP_FIRST : ""
              } ${i === BID_SUB.length - 1 ? BID_GROUP_LAST : ""}`}
            >
              <code>{col}</code>
            </th>
          ))}
          {ASK_SUB.map((col, i) => (
            <th
              key={`ask-${col}`}
              className={`text-left px-3 align-middle whitespace-nowrap ${ASK_HEADER} ${
                i === 0 ? ASK_GROUP_FIRST : ""
              } ${i === ASK_SUB.length - 1 ? ASK_GROUP_LAST : ""}`}
            >
              <code>{col}</code>
            </th>
          ))}
          {PLAIN_COLUMNS_RIGHT.map((col) => (
            <th
              key={col}
              className="text-left px-3 align-middle whitespace-nowrap border-b"
            >
              <code>{col}</code>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {instruments.map(([name, inst], i) => (
          <Row
            key={name}
            name={name}
            instrument={inst}
            isLast={i === instruments.length - 1}
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
  );
}

function Row({
  name,
  instrument,
  balance,
  isLast,
}: {
  name: string;
  instrument: (typeof INSTRUMENTS)[keyof typeof INSTRUMENTS];
  balance: number;
  isLast: boolean;
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

  const bidCellBase = `px-3 align-middle whitespace-nowrap ${BID_CELL}`;
  const askCellBase = `px-3 align-middle whitespace-nowrap ${ASK_CELL}`;
  const bidBottom = isLast ? "border-b-2 border-green-400 rounded-b" : "";
  const askBottom = isLast ? "border-b-2 border-red-400 rounded-b" : "";

  return (
    <tr className="border-b last:border-0 h-10">
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{name}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{balance.toFixed(4)}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{price}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{spread}</code>
      </td>
      <td className={`${bidCellBase} ${BID_GROUP_FIRST} ${bidBottom}`}>
        <code>{fmtDepth("bids", "25")}</code>
      </td>
      <td className={`${bidCellBase} ${bidBottom}`}>
        <code>{fmtDepth("bids", "5")}</code>
      </td>
      <td className={`${bidCellBase} ${BID_GROUP_LAST} ${bidBottom}`}>
        <code>{fmtDepth("bids", "1")}</code>
      </td>
      <td className={`${askCellBase} ${ASK_GROUP_FIRST} ${askBottom}`}>
        <code>{fmtDepth("asks", "1")}</code>
      </td>
      <td className={`${askCellBase} ${askBottom}`}>
        <code>{fmtDepth("asks", "5")}</code>
      </td>
      <td className={`${askCellBase} ${ASK_GROUP_LAST} ${askBottom}`}>
        <code>{fmtDepth("asks", "25")}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <input
          type="number"
          min={0}
          placeholder="qty ↵"
          value={buyAmount}
          onChange={(e) => setBuyAmount(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit("buy", buyAmount);
          }}
          disabled={marketOrder.isPending}
          className="w-20 border px-1 font-mono text-sm h-7 placeholder:text-gray-300 disabled:opacity-50"
        />
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <input
          type="number"
          min={0}
          placeholder="qty ↵"
          value={sellAmount}
          onChange={(e) => setSellAmount(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit("sell", sellAmount);
          }}
          disabled={marketOrder.isPending}
          className="w-20 border px-1 font-mono text-sm h-7 placeholder:text-gray-300 disabled:opacity-50"
        />
      </td>
    </tr>
  );
}
