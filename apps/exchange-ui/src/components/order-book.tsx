"use client";

import { useMemo, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { orderBookOptions, instrumentsOptions } from "~/lib/queries";
import type { OrderBookLevel } from "~/lib/types";
import { cn } from "~/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

function getTickSizes(basePrice: number): number[] {
  if (basePrice >= 1000) return [10, 1, 0.1, 0.01];
  if (basePrice >= 100) return [1, 0.1, 0.01];
  if (basePrice >= 10) return [1, 0.1, 0.01];
  return [0.1, 0.01, 0.001];
}

function aggregateLevels(
  levels: OrderBookLevel[],
  tickSize: number,
  side: "bid" | "ask"
): OrderBookLevel[] {
  const buckets = new Map<number, number>();

  for (const level of levels) {
    const bucketPrice =
      side === "bid"
        ? Math.floor(level.price / tickSize) * tickSize
        : Math.ceil(level.price / tickSize) * tickSize;
    const key = Number(bucketPrice.toFixed(10));
    buckets.set(key, (buckets.get(key) ?? 0) + level.size);
  }

  const sorted = [...buckets.entries()].sort((a, b) =>
    side === "bid" ? b[0] - a[0] : a[0] - b[0]
  );

  let total = 0;
  return sorted.map(([price, size]) => {
    total += size;
    return {
      price: Number(price.toFixed(10)),
      size: Number(size.toFixed(6)),
      total: Number(total.toFixed(6)),
    };
  });
}

function OrderBookRow({
  level,
  side,
  maxTotal,
  priceDecimals,
}: {
  level: OrderBookLevel;
  side: "bid" | "ask";
  maxTotal: number;
  priceDecimals: number;
}) {
  const depthPercent = (level.total / maxTotal) * 100;
  const isBid = side === "bid";

  return (
    <div className="relative flex items-center px-3 h-6 text-sm tabular-nums">
      <div
        className={cn(
          "absolute inset-y-0 left-0",
          isBid ? "bg-bid/10" : "bg-ask/10"
        )}
        style={{ width: `${depthPercent}%` }}
      />
      <span
        className={cn(
          "relative w-1/4 text-left",
          isBid ? "text-bid" : "text-ask"
        )}
      >
        {level.price.toLocaleString(undefined, {
          minimumFractionDigits: priceDecimals,
          maximumFractionDigits: priceDecimals,
        })}
      </span>
      <span className="relative w-3/8 text-right">
        {level.size.toFixed(3)}
      </span>
      <span className="relative w-3/8 text-right">
        {level.total.toFixed(3)}
      </span>
    </div>
  );
}

export function OrderBook({ instrument }: { instrument: string }) {
  const { data } = useSuspenseQuery(orderBookOptions(instrument));
  const { data: instruments } = useSuspenseQuery(instrumentsOptions);

  const base =
    instruments.find((i) => i.id === instrument)?.base ??
    instrument.split("-")[0];

  const tickSizes = useMemo(
    () => getTickSizes(data.lastPrice),
    [data.lastPrice]
  );
  const [tickSize, setTickSize] = useState<number | null>(null);
  const activeTickSize = tickSize ?? tickSizes[tickSizes.length - 1];

  const priceDecimals = Math.max(
    0,
    -Math.floor(Math.log10(activeTickSize))
  );

  const bids = useMemo(
    () => aggregateLevels(data.bids, activeTickSize, "bid"),
    [data.bids, activeTickSize]
  );
  const asks = useMemo(
    () => aggregateLevels(data.asks, activeTickSize, "ask"),
    [data.asks, activeTickSize]
  );

  const visibleBids = bids.slice(0, 10);
  const visibleAsks = asks.slice(0, 10);

  const maxBidTotal = visibleBids.length ? visibleBids[visibleBids.length - 1].total : 1;
  const maxAskTotal = visibleAsks.length ? visibleAsks[visibleAsks.length - 1].total : 1;
  const maxTotal = Math.max(maxBidTotal, maxAskTotal)

  const isPositive = data.lastPrice >= (data.bids[0]?.price ?? 0);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-3 h-8 text-xs font-medium text-muted-foreground border-b border-border shrink-0">
        <div className="w-1/4 flex flex items-center justify-start gap-2">
          Price
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-0.5 px-1 py-0.5 rounded tabular-nums text-muted-foreground hover:text-foreground hover:bg-muted transition-colors outline-none">
              {activeTickSize}
              <ChevronDown className="h-2.5 w-2.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-[80px]">
              {tickSizes.map((ts) => (
                <DropdownMenuItem
                  key={ts}
                  className={cn(
                    "tabular-nums text-sm cursor-pointer",
                    ts === activeTickSize && "bg-muted"
                  )}
                  onClick={() => setTickSize(ts)}
                >
                  {ts}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <span className="w-3/8 text-right">Size ({base})</span>
        <span className="w-3/8 text-right">Total ({base})</span>
      </div>
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        <div className="flex-1 overflow-y-auto flex flex-col justify-end">
          {[...visibleAsks].reverse().map((level) => (
            <OrderBookRow
              key={level.price}
              level={level}
              side="ask"
              maxTotal={maxTotal}
              priceDecimals={priceDecimals}
            />
          ))}
        </div>
        <div className="px-3 h-8 border-y border-border flex items-center gap-2 bg-muted/20">
          <span
            className={cn(
              "tabular-nums text-sm",
              isPositive ? "text-bid" : "text-ask"
            )}
          >
            {data.lastPrice.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
          <span className="text-xs text-muted-foreground ml-4">
            Spread: <span className="tabular-nums">{data.spread.toFixed(2)}</span>
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {visibleBids.map((level) => (
            <OrderBookRow
              key={level.price}
              level={level}
              side="bid"
              maxTotal={maxTotal}
              priceDecimals={priceDecimals}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
