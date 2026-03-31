import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { getQueryClient } from "~/lib/get-query-client";
import { instrumentsOptions, tickerOptions } from "~/lib/queries";
import { INSTRUMENTS, generateTicker } from "~/lib/data";
import { TickerBar } from "~/components/ticker-bar";

export default async function TradePage({
  searchParams,
}: {
  searchParams: Promise<{ instrument?: string }>;
}) {
  const { instrument = "GOLD-USDC" } = await searchParams;

  const queryClient = getQueryClient();
  queryClient.setQueryData(instrumentsOptions.queryKey, INSTRUMENTS);
  queryClient.setQueryData(
    tickerOptions(instrument).queryKey,
    generateTicker(instrument)
  );

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div className="flex flex-col flex-1">
        <TickerBar instrument={instrument} />
        <div className="flex flex-1 min-h-0">
          <div className="w-[65%] border-r border-border flex items-center justify-center">
            <span className="text-muted-foreground text-sm">Price Chart</span>
          </div>
          <div className="w-[35%] flex items-center justify-center">
            <span className="text-muted-foreground text-sm">Order Book</span>
          </div>
        </div>
      </div>
    </HydrationBoundary>
  );
}
