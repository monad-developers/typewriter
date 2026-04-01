import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { getQueryClient } from "~/lib/tanstack";
import { instrumentsOptions, tickerOptions, orderBookOptions, candlesOptions, tradesOptions } from "~/lib/queries";
import { INSTRUMENTS, generateTicker, generateOrderBook, generateCandles, generateTrades } from "~/lib/data";
import { TradeView } from "~/components/trade-view";

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
  queryClient.setQueryData(
    tradesOptions(instrument).queryKey,
    generateTrades(instrument)
  );

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <TradeView initialInstrument={instrument} />
    </HydrationBoundary>
  );
}
