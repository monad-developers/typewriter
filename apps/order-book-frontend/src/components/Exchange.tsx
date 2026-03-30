import { type KeyboardEvent, useCallback, useRef, useState } from "react";
import { formatEther } from "viem";
import { CURRENCIES, formatCurrency } from "../constants";
import { useAccountContext } from "../contexts/AccountContext";
import { useExchangeState } from "../hooks/useExchangeState";

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

export function Exchange({ denominationId }: { denominationId: number }) {
  const { account } = useAccountContext();
  const { data: state } = useExchangeState();
  const tableRef = useRef<HTMLTableElement>(null);

  const acct = state?.accounts[account?.accountId ?? -1];
  const denomCurrency = CURRENCIES[denominationId];

  // One row per currency that isn't the current denomination
  const rows = CURRENCIES.map((_, i) => i).filter((i) => i !== denominationId);

  // All input values keyed by assetId
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

  function submitOne(assetId: number, side: "buy" | "sell", amount: string) {
    // TODO: POST /api/market-order
    console.log(side, { assetId, amount });
    setValue(assetId, side, "");
  }

  function executeAll() {
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
    if (trades.length > 0) {
      // TODO: POST /api/market-order for each trade
      console.log("execute all", trades);
      setValues({});
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
            balance={acct?.balances[assetId] ?? "0"}
            denomCurrency={denomCurrency}
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
  balance,
  denomCurrency,
  buyAmount,
  sellAmount,
  onValueChange,
  onSubmitOne,
  onGridNav,
  onExecuteAll,
}: {
  rowIndex: number;
  assetId: number;
  balance: string;
  denomCurrency: (typeof CURRENCIES)[number] | undefined;
  buyAmount: string;
  sellAmount: string;
  onValueChange: (assetId: number, field: "buy" | "sell", value: string) => void;
  onSubmitOne: (assetId: number, side: "buy" | "sell", amount: string) => void;
  onGridNav: (e: KeyboardEvent<HTMLInputElement>) => void;
  onExecuteAll: () => void;
}) {
  const currency = CURRENCIES[assetId];

  // Seed price from rateToUsd cross rate
  // TODO: derive from order book best bid/ask
  const price =
    denomCurrency && currency
      ? (denomCurrency.rateToUsd / currency.rateToUsd).toFixed(
          currency.decimals + 2,
        )
      : "—";

  // TODO: compute cumulative quantity within basis point range from mid price
  const depth25Bid = "—";
  const depth10Bid = "—";
  const depth5Bid = "—";
  const depth1Bid = "—";
  const depth1Ask = "—";
  const depth5Ask = "—";
  const depth10Ask = "—";
  const depth25Ask = "—";

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
