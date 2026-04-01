"use client";

import { useSuspenseQuery } from "@tanstack/react-query";
import { tickerOptions } from "~/lib/queries";
import { InstrumentPicker } from "./instrument-picker";
import { cn } from "~/lib/utils";

export function TickerBar({
  instrument,
  onInstrumentChange,
}: {
  instrument: string;
  onInstrumentChange: (id: string) => void;
}) {
  const { data: ticker } = useSuspenseQuery(tickerOptions(instrument));

  const isPositive = ticker.change24h >= 0;

  return (
    <div className="h-12 bg-card border-b border-border px-4 md:px-6 flex items-center gap-6 shrink-0">
      <InstrumentPicker selected={instrument} onSelect={onInstrumentChange} className="-ml-[12px]" />
      <Stat
        label="Price"
        value={ticker.lastPrice.toLocaleString()}
        className={isPositive ? "text-bid" : "text-ask"}
      />
      <Stat
        label="24h Change"
        value={`${isPositive ? "+" : ""}${ticker.change24h.toLocaleString()} / ${isPositive ? "+" : ""}${ticker.changePercent24h.toFixed(2)}%`}
        className={isPositive ? "text-bid" : "text-ask"}
      />
      <Stat label="24h High" value={ticker.high24h.toLocaleString()} />
      <Stat label="24h Low" value={ticker.low24h.toLocaleString()} />
      <Stat label="24h Volume" value={ticker.volume24h.toLocaleString()} />
    </div>
  );
}

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
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground leading-none">
        {label}
      </span>
      <span className={cn("text-xs tabular-nums leading-none", className)}>
        {value}
      </span>
    </div>
  );
}