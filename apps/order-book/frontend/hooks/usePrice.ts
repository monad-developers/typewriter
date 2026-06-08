import { useQuery } from "@tanstack/react-query";
import { request } from "../lib/api";

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
      return request<PriceResponse>(`/api/price?instrumentId=${instrumentId}`);
    },
    refetchInterval: 500,
  });
}
