import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";

export type InstrumentPriceResponse = {
  instrumentId: number;
  base: Address;
  quote: Address;
  bestBid: number | null;
  bestAsk: number | null;
  bids: {
    price: number;
    quantity: string;
    remainingQuantity: string;
    volume: number;
  }[];
  asks: {
    price: number;
    quantity: string;
    remainingQuantity: string;
    volume: number;
  }[];
};

export function useInstrumentPrice(instrumentId: number) {
  return useQuery({
    queryKey: ["instrument-price", instrumentId],
    queryFn: async () => {
      const res = await fetch(
        `/api/instrument-price?instrumentId=${instrumentId}`,
      );
      if (!res.ok) throw new Error("Failed to fetch instrument price");
      return (await res.json()) as InstrumentPriceResponse;
    },
    refetchInterval: 2000,
  });
}
