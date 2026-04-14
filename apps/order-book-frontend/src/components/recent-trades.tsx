"use client";

import { useSuspenseQuery } from "@tanstack/react-query";
import { instrumentsOptions, tradesOptions } from "~/lib/queries";
import { cn } from "~/lib/utils";

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function RecentTrades({ instrument }: { instrument: string }) {
  const { data: trades } = useSuspenseQuery(tradesOptions(instrument));
  const { data: instruments } = useSuspenseQuery(instrumentsOptions);

  const base =
    instruments.find((i) => i.id === instrument)?.base ??
    instrument.split("-")[0];
  
  const recent = trades.slice(-50).reverse();

  return (
    <div className="flex flex-col h-full max-h-[600px]">
      <div className="flex items-center px-3 h-8 text-xs font-medium text-muted-foreground border-b border-border shrink-0">
        <span className="w-1/4">Price</span>
        <span className="w-3/8 text-right">Size ({base})</span>
        <span className="w-3/8 text-right">Time</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {recent.map((trade) => (
          <div
            key={trade.id}
            className="flex items-center px-3 h-6 text-sm tabular-nums"
          >
            <span
              className={cn(
                "w-1/4",
                trade.side === "buy" ? "text-bid" : "text-ask"
              )}
            >
              {trade.price.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
            <span className="w-3/8 text-right">
              {trade.size.toFixed(3)}
            </span>
            <span className="w-3/8 text-right">
              {formatTime(trade.timestamp)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
