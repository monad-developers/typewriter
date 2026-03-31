import { useQuery } from "@tanstack/react-query";

export type InstrumentPriceResponse = {
  instrumentId: number;
  baseId: number;
  quoteId: number;
  bestBid: number | null;
  bestAsk: number | null;
  bids: {
    tickId: number;
    quantity: string;
    remainingQuantity: string;
    volume: number;
  }[];
  asks: {
    tickId: number;
    quantity: string;
    remainingQuantity: string;
    volume: number;
  }[];
};

export function useInstrumentPrice(baseId: number, quoteId: number) {
  return useQuery({
    queryKey: ["instrument-price", baseId, quoteId],
    queryFn: async () => {
      const res = await fetch(
        `/api/instrument-price?baseId=${baseId}&quoteId=${quoteId}`,
      );
      if (!res.ok) throw new Error("Failed to fetch instrument price");
      return (await res.json()) as InstrumentPriceResponse;
    },
    refetchInterval: 2000,
  });
}
