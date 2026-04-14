"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { TradeView } from "~/components/trade-view";

function TradeContent() {
  const searchParams = useSearchParams();
  const instrument = searchParams.get("instrument") ?? "0";

  return <TradeView initialInstrument={instrument} />;
}

export default function TradePage() {
  return (
    <Suspense>
      <TradeContent />
    </Suspense>
  );
}
