import { useQuery } from "@tanstack/react-query";
import { request } from "../lib/api";

type DepthResponse = {
  bids: Record<string, bigint>;
  asks: Record<string, bigint>;
};

export function useDepth(instrumentId: number) {
  return useQuery({
    queryKey: ["depth", instrumentId],
    queryFn: async () => {
      return request<DepthResponse>(`/api/depth?instrumentId=${instrumentId}`);
    },
    refetchInterval: 500,
  });
}
