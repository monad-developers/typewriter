"use client";

import { useSuspenseQuery } from "@tanstack/react-query";
import { instrumentsOptions, tradesOptions } from "~/lib/queries";
import { cn } from "~/lib/utils";

export function RecentTrades({ instrument }: { instrument: string }) {
  const { data: trades } = useSuspenseQuery(tradesOptions(instrument));
  const { data: instruments } = useSuspenseQuery(instrumentsOptions);

  const base =
    instruments.find((i) => i.id === instrument)?.base ?? "BASE";

  return (
    <div className="flex flex-col h-full max-h-[600px]">
      <div className="flex items-center px-3 h-8 text-xs font-medium text-muted-foreground border-b border-border shrink-0">
        <span className="w-1/3">Price</span>
        <span className="w-1/3 text-right">Size ({base})</span>
        <span className="w-1/3 text-right">Time</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {trades.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            No trades yet
          </div>
        ) : (
          trades.map((trade) => (
            <div
              key={trade.id}
              className="flex items-center px-3 h-6 text-sm tabular-nums"
            >
              <span
                className={cn(
                  "w-1/3",
                  trade.side === "buy" ? "text-bid" : "text-ask"
                )}
              >
                {trade.price.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 4,
                })}
              </span>
              <span className="w-1/3 text-right">
                {trade.size.toFixed(0)}
              </span>
              <span className="w-1/3 text-right text-muted-foreground">
                {trade.timestamp
                  ? new Date(trade.timestamp * 1000).toLocaleTimeString()
                  : "\u2014"}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
