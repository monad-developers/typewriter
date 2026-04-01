import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { getQueryClient } from "~/lib/get-query-client";
import {
  instrumentsOptions,
  tickerOptions,
  orderBookOptions,
  candlesOptions,
} from "~/lib/queries";
import {
  INSTRUMENTS,
  generateTicker,
  generateOrderBook,
  generateCandles,
} from "~/lib/data";
import { TickerBar } from "~/components/ticker-bar";
import { OrderBook } from "~/components/order-book";
import { PriceChart } from "~/components/price-chart";

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
  queryClient.setQueryData(
    orderBookOptions(instrument).queryKey,
    generateOrderBook(instrument)
  );
  queryClient.setQueryData(
    candlesOptions(instrument).queryKey,
    generateCandles(instrument)
  );

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div className="flex flex-col flex-1 h-0">
        <TickerBar instrument={instrument} />
        <div className="flex flex-row">
          <div className="w-[65%] border-r border-border">
            <PriceChart instrument={instrument} />
          </div>
          <div className="w-[35%]">
            <OrderBook instrument={instrument} />
          </div>
        </div>
      </div>
    </HydrationBoundary>
  );
}
