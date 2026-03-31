import { useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useCallback, useRef, useState } from "react";
import { formatEther, parseEther } from "viem";
import { CURRENCIES, TICK_SCALE, formatCurrency } from "../constants";
import { useAccountContext } from "../contexts/AccountContext";
import { useBalances } from "../hooks/useBalances";
import {
  type InstrumentPriceResponse,
  useInstrumentPrice,
} from "../hooks/useInstrumentPrice";

const COLUMNS = [
  "",
  "position",
  "rate",
  "25bp bid",
  "10bp bid",
  "5bp bid",
  "1bp bid",
  "1bp ask",
  "5bp ask",
  "10bp ask",
  "25bp ask",
  "buy",
  "sell",
];

const INPUT_COLS = 2; // buy, sell

function focusCell(table: HTMLTableElement, row: number, col: number) {
  const input = table.querySelector<HTMLInputElement>(
    `input[data-row="${row}"][data-col="${col}"]`,
  );
  if (input) {
    input.focus();
    input.select();
  }
}

type RowValues = { buy: string; sell: string };

function computeDepth(
  instrument: InstrumentPriceResponse,
  bpRange: number,
  side: "bid" | "ask",
): string {
  const { bestBid, bestAsk } = instrument;
  if (bestBid === null || bestAsk === null) return "—";

  const mid = (bestBid + bestAsk) / 2;
  const ticks = side === "bid" ? instrument.bids : instrument.asks;
  const threshold =
    side === "bid" ? mid * (1 - bpRange / 10000) : mid * (1 + bpRange / 10000);

  let total = 0n;
  for (const tick of ticks) {
    if (side === "bid" && tick.tickId < threshold) break;
    if (side === "ask" && tick.tickId > threshold) break;
    total += BigInt(tick.remainingQuantity);
  }

  return formatEther(total);
}

export function Exchange({ denominationId }: { denominationId: number }) {
  const { account } = useAccountContext();
  const { data: balancesData } = useBalances(account.accountId);
  const queryClient = useQueryClient();
  const tableRef = useRef<HTMLTableElement>(null);

  const rows = CURRENCIES.map((_, i) => i).filter((i) => i !== denominationId);

  const [values, setValues] = useState<Record<number, RowValues>>({});

  const setValue = useCallback(
    (assetId: number, field: "buy" | "sell", value: string) => {
      setValues((prev) => ({
        ...prev,
        [assetId]: { ...prev[assetId], buy: prev[assetId]?.buy ?? "", sell: prev[assetId]?.sell ?? "", [field]: value },
      }));
    },
    [],
  );

  async function postMarketOrder(
    assetId: number,
    side: "buy" | "sell",
    amount: string,
  ) {
    const res = await fetch("/api/market-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: account.accountId,
        baseId: assetId,
        quoteId: denominationId,
        bidOrAsk: side === "buy" ? 0 : 1,
        quantity: parseEther(amount).toString(),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error ?? "Order failed");
    }
    return res.json();
  }

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["balances"] });
    queryClient.invalidateQueries({ queryKey: ["instrument-price"] });
  }

  async function submitOne(assetId: number, side: "buy" | "sell", amount: string) {
    try {
      await postMarketOrder(assetId, side, amount);
      setValue(assetId, side, "");
      invalidate();
    } catch (err) {
      console.error("Order failed:", err);
    }
  }

  async function executeAll() {
    const trades: { assetId: number; side: "buy" | "sell"; amount: string }[] = [];
    for (const assetId of rows) {
      const rv = values[assetId];
      if (rv?.buy && Number(rv.buy) > 0) {
        trades.push({ assetId, side: "buy", amount: rv.buy });
      }
      if (rv?.sell && Number(rv.sell) > 0) {
        trades.push({ assetId, side: "sell", amount: rv.sell });
      }
    }
    if (trades.length === 0) return;
    try {
      await Promise.all(
        trades.map((t) => postMarketOrder(t.assetId, t.side, t.amount)),
      );
      setValues({});
      invalidate();
    } catch (err) {
      console.error("Batch order failed:", err);
    }
  }

  function handleGridNav(e: KeyboardEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const row = Number(input.dataset["row"]);
    const col = Number(input.dataset["col"]);
    const table = tableRef.current;
    if (!table) return;

    let nextRow = row;
    let nextCol = col;

    switch (e.key) {
      case "ArrowUp":
        nextRow = Math.max(0, row - 1);
        break;
      case "ArrowDown":
        nextRow = Math.min(rows.length - 1, row + 1);
        break;
      case "ArrowLeft":
        nextCol = Math.max(0, col - 1);
        break;
      case "ArrowRight":
      case "Tab":
        if (e.shiftKey) {
          nextCol = Math.max(0, col - 1);
        } else {
          nextCol = Math.min(INPUT_COLS - 1, col + 1);
        }
        break;
      default:
        return;
    }

    if (nextRow !== row || nextCol !== col) {
      e.preventDefault();
      focusCell(table, nextRow, nextCol);
    }
  }

  return (
    <table ref={tableRef} className="w-full border-collapse">
      <thead>
        <tr className="border-b h-10">
          {COLUMNS.map((col) => (
            <th key={col || "name"} className="text-left px-3 align-middle whitespace-nowrap">
              <code>{col}</code>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((assetId, rowIndex) => (
          <Row
            key={assetId}
            rowIndex={rowIndex}
            assetId={assetId}
            denominationId={denominationId}
            balance={balancesData?.balances[assetId] ?? "0"}
            buyAmount={values[assetId]?.buy ?? ""}
            sellAmount={values[assetId]?.sell ?? ""}
            onValueChange={setValue}
            onSubmitOne={submitOne}
            onGridNav={handleGridNav}
            onExecuteAll={executeAll}
          />
        ))}
      </tbody>
    </table>
  );
}

function Row({
  rowIndex,
  assetId,
  denominationId,
  balance,
  buyAmount,
  sellAmount,
  onValueChange,
  onSubmitOne,
  onGridNav,
  onExecuteAll,
}: {
  rowIndex: number;
  assetId: number;
  denominationId: number;
  balance: string;
  buyAmount: string;
  sellAmount: string;
  onValueChange: (assetId: number, field: "buy" | "sell", value: string) => void;
  onSubmitOne: (assetId: number, side: "buy" | "sell", amount: string) => void;
  onGridNav: (e: KeyboardEvent<HTMLInputElement>) => void;
  onExecuteAll: () => void;
}) {
  const currency = CURRENCIES[assetId];
  const denomCurrency = CURRENCIES[denominationId];
  const { data: instrument } = useInstrumentPrice(assetId, denominationId);

  const price =
    instrument?.bestBid != null && instrument?.bestAsk != null
      ? ((instrument.bestBid + instrument.bestAsk) / 2 / TICK_SCALE).toFixed(
          currency?.decimals ? currency.decimals + 2 : 2,
        )
      : "—";

  const fmtDepth = (bp: number, side: "bid" | "ask") => {
    if (!instrument) return "—";
    const raw = computeDepth(instrument, bp, side);
    return currency ? formatCurrency(raw, currency) : raw;
  };

  const depth25Bid = fmtDepth(25, "bid");
  const depth10Bid = fmtDepth(10, "bid");
  const depth5Bid = fmtDepth(5, "bid");
  const depth1Bid = fmtDepth(1, "bid");
  const depth1Ask = fmtDepth(1, "ask");
  const depth5Ask = fmtDepth(5, "ask");
  const depth10Ask = fmtDepth(10, "ask");
  const depth25Ask = fmtDepth(25, "ask");

  const inventory = formatEther(BigInt(balance));

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onExecuteAll();
      return;
    }
    if (e.key === "Enter") {
      const col = Number(e.currentTarget.dataset["col"]);
      const side = col === 0 ? "buy" as const : "sell" as const;
      const value = col === 0 ? buyAmount : sellAmount;
      if (value) {
        onSubmitOne(assetId, side, value);
      }
      return;
    }
    onGridNav(e);
  }

  return (
    <tr className="border-b last:border-0 h-10">
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{currency?.flag} {currency?.code}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{currency ? formatCurrency(inventory, currency) : inventory}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{denomCurrency ? formatCurrency(price, denomCurrency) : price}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{depth25Bid}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{depth10Bid}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{depth5Bid}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{depth1Bid}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{depth1Ask}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{depth5Ask}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{depth10Ask}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{depth25Ask}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <input
          type="number"
          min={0}
          placeholder="0"
          value={buyAmount}
          onChange={(e) => onValueChange(assetId, "buy", e.target.value)}
          onKeyDown={handleKeyDown}
          data-row={rowIndex}
          data-col={0}
          className="w-20 border px-1 font-mono text-sm h-7 placeholder:text-gray-300"
        />
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <input
          type="number"
          min={0}
          placeholder="0"
          value={sellAmount}
          onChange={(e) => onValueChange(assetId, "sell", e.target.value)}
          onKeyDown={handleKeyDown}
          data-row={rowIndex}
          data-col={1}
          className="w-20 border px-1 font-mono text-sm h-7 placeholder:text-gray-300"
        />
      </td>
    </tr>
  );
}
