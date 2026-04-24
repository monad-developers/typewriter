import { useQuery } from "@tanstack/react-query";

type PriceResponse = {
  instrumentId: number;
  price: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
};

export function usePrice(instrumentId: number) {
  return useQuery({
    queryKey: ["price", instrumentId],
    queryFn: async () => {
      const res = await fetch(`/api/price?instrumentId=${instrumentId}`);
      if (!res.ok) throw new Error("Failed to fetch price");
      return (await res.json()) as PriceResponse;
    },
    refetchInterval: 2000,
  });
}
