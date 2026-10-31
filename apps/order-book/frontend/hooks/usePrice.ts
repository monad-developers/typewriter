import { useQuery } from "@tanstack/react-query";
import { request } from "../lib/api";

type PriceResponse = {
  price: bigint | null;
  bestBid: bigint | null;
  bestAsk: bigint | null;
  spread: bigint | null;
};

export function usePrice(instrumentId: number) {
  return useQuery({
    queryKey: ["price", instrumentId],
    queryFn: async () => {
      return request<PriceResponse>(`/api/price?instrumentId=${instrumentId}`);
    },
    refetchInterval: 500,
  });
}
