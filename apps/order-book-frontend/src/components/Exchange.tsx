import { type KeyboardEvent, useCallback, useRef, useState } from "react";
import { CURRENCIES, formatCurrency, Q32 } from "../constants";
import { useAccountContext } from "../contexts/AccountContext";
import { useBalances } from "../hooks/useBalances";
import {
  type InstrumentPriceResponse,
  useInstrumentPrice,
} from "../hooks/useInstrumentPrice";
import { useMarketOrderMutation } from "../hooks/useMarketOrderMutation";

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

const INPUT_COLS = 2;

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

function priceToNumber(priceQ32: number): number {
  return priceQ32 / Number(Q32);
}

function computeDepth(
  instrument: InstrumentPriceResponse,
  bpRange: number,
  side: "bid" | "ask",
): string {
  const { bestBid, bestAsk } = instrument;
  const ref =
    bestBid !== null && bestAsk !== null
      ? (bestBid + bestAsk) / 2
      : (bestBid ?? bestAsk);
  if (ref === null) return "\u2014";

  const ticks = side === "bid" ? instrument.bids : instrument.asks;
  const threshold =
    side === "bid" ? ref * (1 - bpRange / 10000) : ref * (1 + bpRange / 10000);

  let total = 0n;
  for (const tick of ticks) {
    if (side === "bid" && tick.price < threshold) break;
    if (side === "ask" && tick.price > threshold) break;
    total += BigInt(tick.remainingQuantity);
  }

  return total.toString();
}

const PAIR_CURRENCY_INDICES = [0, 2, 3, 4];

export function Exchange({ denominationId }: { denominationId: number }) {
  const { account } = useAccountContext();
  const { data: balancesData } = useBalances(account?.address);
  const tableRef = useRef<HTMLTableElement>(null);
  const marketOrderMutation = useMarketOrderMutation();

  const rows = PAIR_CURRENCY_INDICES.filter((i) => i !== denominationId);

  const [values, setValues] = useState<Record<number, RowValues>>({});

  const setValue = useCallback(
    (currencyIndex: number, field: "buy" | "sell", value: string) => {
      setValues((prev) => ({
        ...prev,
        [currencyIndex]: {
          ...prev[currencyIndex],
          buy: prev[currencyIndex]?.buy ?? "",
          sell: prev[currencyIndex]?.sell ?? "",
          [field]: value,
        },
      }));
    },
    [],
  );

  async function postMarketOrder(
    instrumentId: number,
    side: "buy" | "sell",
    amount: string,
    nonceOffset = 0,
  ) {
    return marketOrderMutation.mutateAsync({
      instrumentId,
      side,
      amount,
      nonceOffset,
    });
  }

  async function submitOne(
    currencyIndex: number,
    side: "buy" | "sell",
    amount: string,
  ) {
    const instrumentId = PAIR_CURRENCY_INDICES.indexOf(currencyIndex);
    if (instrumentId === -1) return;
    try {
      await postMarketOrder(instrumentId, side, amount);
      setValue(currencyIndex, side, "");
    } catch (err) {
      console.error("Order failed:", err);
    }
  }

  async function executeAll() {
    const trades: {
      currencyIndex: number;
      side: "buy" | "sell";
      amount: string;
    }[] = [];
    for (const currencyIndex of rows) {
      const rv = values[currencyIndex];
      if (rv?.buy && Number(rv.buy) > 0) {
        trades.push({ currencyIndex, side: "buy", amount: rv.buy });
      }
      if (rv?.sell && Number(rv.sell) > 0) {
        trades.push({ currencyIndex, side: "sell", amount: rv.sell });
      }
    }
    if (trades.length === 0) return;
    try {
      await Promise.all(
        trades.map((t, i) => {
          const instrumentId = PAIR_CURRENCY_INDICES.indexOf(t.currencyIndex);
          return postMarketOrder(instrumentId, t.side, t.amount, i);
        }),
      );
      setValues({});
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
            <th
              key={col || "name"}
              className="text-left px-3 align-middle whitespace-nowrap"
            >
              <code>{col}</code>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((currencyIndex, rowIndex) => {
          const instrumentId = PAIR_CURRENCY_INDICES.indexOf(currencyIndex);
          return (
            <Row
              key={currencyIndex}
              rowIndex={rowIndex}
              currencyIndex={currencyIndex}
              instrumentId={instrumentId}
              denominationId={denominationId}
              balance={
                balancesData?.balances[
                  CURRENCIES[currencyIndex]?.address ?? "0x"
                ] ?? "0"
              }
              buyAmount={values[currencyIndex]?.buy ?? ""}
              sellAmount={values[currencyIndex]?.sell ?? ""}
              onValueChange={setValue}
              onSubmitOne={submitOne}
              onGridNav={handleGridNav}
              onExecuteAll={executeAll}
            />
          );
        })}
      </tbody>
    </table>
  );
}

function Row({
  rowIndex,
  currencyIndex,
  instrumentId,
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
  currencyIndex: number;
  instrumentId: number;
  denominationId: number;
  balance: string;
  buyAmount: string;
  sellAmount: string;
  onValueChange: (
    currencyIndex: number,
    field: "buy" | "sell",
    value: string,
  ) => void;
  onSubmitOne: (
    currencyIndex: number,
    side: "buy" | "sell",
    amount: string,
  ) => void;
  onGridNav: (e: KeyboardEvent<HTMLInputElement>) => void;
  onExecuteAll: () => void;
}) {
  const currency = CURRENCIES[currencyIndex];
  const denomCurrency = CURRENCIES[denominationId];
  const { data: instrument } = useInstrumentPrice(instrumentId);

  const ref =
    instrument?.bestBid != null && instrument?.bestAsk != null
      ? (instrument.bestBid + instrument.bestAsk) / 2
      : (instrument?.bestBid ?? instrument?.bestAsk ?? null);
  const price =
    ref !== null
      ? priceToNumber(ref).toFixed(
          currency?.decimals ? currency.decimals + 2 : 2,
        )
      : "\u2014";

  const fmtDepth = (bp: number, side: "bid" | "ask") => {
    if (!instrument) return "\u2014";
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

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onExecuteAll();
      return;
    }
    if (e.key === "Enter") {
      const col = Number(e.currentTarget.dataset["col"]);
      const side = col === 0 ? ("buy" as const) : ("sell" as const);
      const value = col === 0 ? buyAmount : sellAmount;
      if (value) {
        onSubmitOne(currencyIndex, side, value);
      }
      return;
    }
    onGridNav(e);
  }

  return (
    <tr className="border-b last:border-0 h-10">
      <td className="px-3 align-middle whitespace-nowrap">
        <code>
          {currency?.flag} {currency?.code}
        </code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>{currency ? formatCurrency(balance, currency) : balance}</code>
      </td>
      <td className="px-3 align-middle whitespace-nowrap">
        <code>
          {denomCurrency ? formatCurrency(price, denomCurrency) : price}
        </code>
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
          onChange={(e) => onValueChange(currencyIndex, "buy", e.target.value)}
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
          onChange={(e) => onValueChange(currencyIndex, "sell", e.target.value)}
          onKeyDown={handleKeyDown}
          data-row={rowIndex}
          data-col={1}
          className="w-20 border px-1 font-mono text-sm h-7 placeholder:text-gray-300"
        />
      </td>
    </tr>
  );
}
