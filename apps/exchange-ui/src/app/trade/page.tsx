import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { getQueryClient } from "~/lib/tanstack";
import { instrumentsOptions, tickerOptions, orderBookOptions, candlesOptions, tradesOptions } from "~/lib/queries";
import { INSTRUMENTS, getSimulator } from "~/lib/market-simulator";
import { TradeView } from "~/components/trade-view";

export default async function TradePage({
  searchParams,
}: {
  searchParams: Promise<{ instrument?: string }>;
}) {
  const { instrument = "GOLD-USDC" } = await searchParams;

  const queryClient = getQueryClient();
  const snapshot = getSimulator().getSnapshot(instrument);

  queryClient.setQueryData(instrumentsOptions.queryKey, INSTRUMENTS);
  queryClient.setQueryData(tickerOptions(instrument).queryKey, snapshot.ticker);
  queryClient.setQueryData(orderBookOptions(instrument).queryKey, snapshot.orderbook);
  queryClient.setQueryData(candlesOptions(instrument).queryKey, snapshot.candles);
  queryClient.setQueryData(tradesOptions(instrument).queryKey, snapshot.trades);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <TradeView initialInstrument={instrument} />
    </HydrationBoundary>
  );
}
