"use client";

import { useCallback, useState } from "react";
import { TickerBar } from "./ticker-bar";
import { PriceChart } from "./price-chart";
import { OrderBook } from "./order-book";
import { RecentTrades } from "./recent-trades";
import { cn } from "~/lib/utils";
import { useMarketStream } from "~/lib/stream";
import { DEFAULT_BUCKET, type BucketSize } from "~/lib/types";

const RIGHT_TABS = [
  { id: "book", label: "Order Book" },
  { id: "trades", label: "Trades" },
] as const;

type RightTabId = (typeof RIGHT_TABS)[number]["id"];

export function TradeView({
  initialInstrument,
}: {
  initialInstrument: string;
}) {
  const [instrument, setInstrument] = useState(initialInstrument);
  const [bucket, setBucket] = useState<BucketSize>(DEFAULT_BUCKET);
  const [rightTab, setRightTab] = useState<RightTabId>("book");
  useMarketStream(instrument);

  const onInstrumentChange = useCallback((id: string) => {
    setInstrument(id);
    window.history.replaceState(null, "", `/trade?instrument=${id}`);
  }, []);

  return (
    <div className="flex flex-col flex-1 h-0">
      <TickerBar
        instrument={instrument}
        onInstrumentChange={onInstrumentChange}
      />
      <div className="flex flex-row flex-1">
        <div className="w-[65%] h-[584px] border-r border-b border-border">
          <PriceChart instrument={instrument} bucket={bucket} onBucketChange={setBucket} />
        </div>
        <div className="w-[35%] h-[584px] flex flex-col border-b border-border">
          <div className="flex items-center border-b border-border shrink-0">
            {RIGHT_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setRightTab(tab.id)}
                className={cn(
                  "w-full px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                  rightTab === tab.id
                    ? "text-foreground border-b-[1px] border-foreground"
                    : "text-muted-foreground hover:text-foreground border-b-[1px] border-transparent"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto">
            {rightTab === "book" ? (
              <OrderBook instrument={instrument} />
            ) : (
              <RecentTrades instrument={instrument} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
