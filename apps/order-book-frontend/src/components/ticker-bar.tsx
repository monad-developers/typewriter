"use client";

import { useSuspenseQuery } from "@tanstack/react-query";
import { orderBookOptions } from "~/lib/queries";
import { InstrumentPicker } from "./instrument-picker";
import { cn } from "~/lib/utils";

export function TickerBar({
  instrument,
  onInstrumentChange,
}: {
  instrument: string;
  onInstrumentChange: (id: string) => void;
}) {
  const { data: book } = useSuspenseQuery(orderBookOptions(instrument));

  const bestBid = book.bids[0]?.price ?? 0;
  const bestAsk = book.asks[0]?.price ?? 0;

  return (
    <div className="h-12 bg-card border-b border-border px-4 md:px-6 flex items-center gap-6 shrink-0">
      <InstrumentPicker
        selected={instrument}
        onSelect={onInstrumentChange}
        className="-ml-[12px]"
      />
      <Stat
        label="Price"
        value={book.lastPrice ? book.lastPrice.toLocaleString() : "\u2014"}
        className="text-foreground"
      />
      <Stat
        label="Best Bid"
        value={bestBid ? bestBid.toLocaleString() : "\u2014"}
        className="text-bid"
      />
      <Stat
        label="Best Ask"
        value={bestAsk ? bestAsk.toLocaleString() : "\u2014"}
        className="text-ask"
      />
      <Stat
        label="Spread"
        value={book.spread ? book.spread.toFixed(4) : "\u2014"}
      />
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
