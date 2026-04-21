"use client";

import { useEffect, useState } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { cn } from "~/lib/utils";
import { accountOptions } from "~/lib/account";
import { useBalances } from "~/hooks/use-balances";
import { useMarketOrderMutation } from "~/hooks/use-market-order";
import { useLimitOrderMutation } from "~/hooks/use-limit-order";
import { instrumentsOptions, orderBookOptions } from "~/lib/queries";
import { priceToQ32 } from "order-book-sdk";
import { TokenAmount, instrumentConfig } from "~/lib/constants";

const ORDER_TABS = [
  { id: "limit", label: "Limit" },
  { id: "market", label: "Market" },
] as const;

type OrderTabId = (typeof ORDER_TABS)[number]["id"];
type Side = "buy" | "sell";

const QTY_PRESETS = [10, 50, 100, 500];

export function ActionsPanel({ instrument }: { instrument: string }) {
  const [tab, setTab] = useState<OrderTabId>("limit");
  const [side, setSide] = useState<Side>("buy");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: account } = useQuery(accountOptions);
  const { data: balances } = useBalances(account?.accountId);
  const { data: instruments } = useSuspenseQuery(instrumentsOptions);
  const { data: book } = useSuspenseQuery(orderBookOptions(instrument));
  const marketOrder = useMarketOrderMutation();
  const limitOrder = useLimitOrderMutation();

  const inst = instruments.find((i) => i.id === instrument);
  const isPending = marketOrder.isPending || limitOrder.isPending;

  // Pre-fill price from best bid/ask when side or instrument changes
  useEffect(() => {
    if (!book) return;
    const best = side === "buy" ? book.bids[0]?.price : book.asks[0]?.price;
    if (best) setPrice(String(best));
  }, [side, instrument]);

  function resetForm() {
    setQuantity("");
    setError(null);
    marketOrder.reset();
    limitOrder.reset();
  }

  async function handleSubmit() {
    setError(null);

    if (!account) {
      setError("Not signed in");
      return;
    }
    if (!inst) {
      setError("No instrument selected");
      return;
    }

    const qty = Number(quantity);
    if (!qty || qty <= 0) {
      setError("Enter a valid quantity");
      return;
    }

    // Quantity is entered in lots; contract mutations take full base amounts.
    const cfg = instrumentConfig(Number(instrument));
    const rawQty = BigInt(Math.round(qty)) << BigInt(cfg.baseLotExp);

    try {
      if (tab === "market") {
        await marketOrder.mutateAsync({
          instrumentId: Number(instrument),
          side,
          quantity: rawQty,
        });
      } else {
        const p = Number(price);
        if (!p || p <= 0) {
          setError("Enter a valid price");
          return;
        }
        const rawPrice = priceToQ32(p, cfg);

        await limitOrder.mutateAsync({
          instrumentId: Number(instrument),
          side,
          quantity: rawQty,
          price: rawPrice,
        });
      }
      resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Order failed");
    }
  }

  // Show relevant balance using TokenAmount for proper 18-decimal conversion
  let relevantBalance = "0";
  if (inst && balances) {
    const addr = (
      side === "buy" ? inst.quoteAddress : inst.baseAddress
    ) as `0x${string}`;
    const raw = balances.balances[addr];
    if (raw && raw !== "0") {
      relevantBalance = TokenAmount.fromRaw(BigInt(raw), addr).human.toLocaleString();
    }
  }
  const relevantAsset = inst
    ? side === "buy"
      ? inst.quote
      : inst.base
    : "";

  // Estimated total for limit orders
  const estimatedTotal =
    tab === "limit" && Number(quantity) > 0 && Number(price) > 0
      ? (Number(quantity) * Number(price)).toLocaleString(undefined, {
          maximumFractionDigits: 2,
        })
      : null;

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border shrink-0">
        {ORDER_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setTab(t.id);
              setError(null);
            }}
            className={cn(
              "w-full px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
              tab === t.id
                ? "text-foreground border-b-[1px] border-foreground"
                : "text-muted-foreground hover:text-foreground border-b-[1px] border-transparent",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 p-3 flex flex-col gap-2.5">
        {/* Buy/Sell toggle */}
        <div className="flex gap-1 p-0.5 bg-muted rounded-md">
          <button
            onClick={() => setSide("buy")}
            className={cn(
              "flex-1 py-1.5 text-sm font-medium rounded transition-colors cursor-pointer",
              side === "buy"
                ? "bg-bid text-white"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Buy
          </button>
          <button
            onClick={() => setSide("sell")}
            className={cn(
              "flex-1 py-1.5 text-sm font-medium rounded transition-colors cursor-pointer",
              side === "sell"
                ? "bg-ask text-white"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Sell
          </button>
        </div>

        {/* Price input (limit only) */}
        {tab === "limit" && (
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              Price ({inst?.quote ?? "—"})
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              className="w-full px-3 py-2 text-sm tabular-nums bg-muted rounded-md border border-border focus:outline-none focus:border-foreground transition-colors"
            />
          </div>
        )}

        {/* Quantity input + presets */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            Quantity ({inst?.base ?? "—"})
          </label>
          <input
            type="text"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="0"
            className="w-full px-3 py-2 text-sm tabular-nums bg-muted rounded-md border border-border focus:outline-none focus:border-foreground transition-colors"
          />
          <div className="flex gap-1.5 mt-1.5">
            {QTY_PRESETS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQuantity(String(q))}
                className={cn(
                  "flex-1 py-1 text-xs rounded border transition-colors cursor-pointer",
                  quantity === String(q)
                    ? "border-foreground text-foreground bg-muted"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/50",
                )}
              >
                {q}
              </button>
            ))}
          </div>
        </div>

        {/* Estimated total (limit only) */}
        {estimatedTotal && (
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Est. total</span>
            <span className="tabular-nums">
              {estimatedTotal} {inst?.quote}
            </span>
          </div>
        )}

        {/* Available balance */}
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Available</span>
          <span className="tabular-nums">
            {relevantBalance} {relevantAsset}
          </span>
        </div>

        {/* Error */}
        {(error || marketOrder.error || limitOrder.error) && (
          <p className="text-xs text-destructive">
            {error ??
              (marketOrder.error instanceof Error
                ? marketOrder.error.message
                : null) ??
              (limitOrder.error instanceof Error
                ? limitOrder.error.message
                : null) ??
              "Order failed"}
          </p>
        )}

        {/* Submit */}
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={isPending || !account}
          className={cn(
            "w-full py-2.5 text-sm font-medium rounded-md transition-colors disabled:opacity-50 cursor-pointer mt-auto",
            side === "buy"
              ? "bg-bid hover:bg-bid/90 text-white"
              : "bg-ask hover:bg-ask/90 text-white",
          )}
        >
          {isPending
            ? "Submitting..."
            : `${side === "buy" ? "Buy" : "Sell"} ${inst?.base ?? ""}`}
        </button>
      </div>
    </div>
  );
}
