"use client";

import { useSuspenseQuery } from "@tanstack/react-query";
import { tickerOptions } from "~/lib/queries";
import { InstrumentPicker } from "./instrument-picker";
import { cn } from "~/lib/utils";

function Stat({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground leading-none">
        {label}
      </span>
      <span className={cn("text-sm font-mono leading-none", className)}>
        {value}
      </span>
    </div>
  );
}

export function TickerBar({ instrument }: { instrument: string }) {
  const { data: ticker } = useSuspenseQuery(tickerOptions(instrument));

  const isPositive = ticker.change24h >= 0;

  return (
    <div className="h-12 bg-card border-b border-border px-4 flex items-center gap-6 shrink-0">
      <InstrumentPicker selected={instrument} />
      <span
        className={cn(
          "font-mono text-lg font-bold",
          isPositive ? "text-bid" : "text-ask"
        )}
      >
        {ticker.lastPrice.toLocaleString()}
      </span>
      <Stat
        label="24h Change"
        value={`${isPositive ? "+" : ""}${ticker.change24h.toLocaleString()} (${isPositive ? "+" : ""}${ticker.changePercent24h.toFixed(2)}%)`}
        className={isPositive ? "text-bid" : "text-ask"}
      />
      <Stat label="24h High" value={ticker.high24h.toLocaleString()} />
      <Stat label="24h Low" value={ticker.low24h.toLocaleString()} />
      <Stat label="24h Volume" value={ticker.volume24h.toLocaleString()} />
    </div>
  );
}
