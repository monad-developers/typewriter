import { useQuery } from "@tanstack/react-query";

type DepthResponse = {
  instrumentId: number;
  bids: Record<string, string>;
  asks: Record<string, string>;
};

export function useDepth(instrumentId: number) {
  return useQuery({
    queryKey: ["depth", instrumentId],
    queryFn: async () => {
      const res = await fetch(`/api/depth?instrumentId=${instrumentId}`);
      if (!res.ok) throw new Error("Failed to fetch depth");
      return (await res.json()) as DepthResponse;
    },
    refetchInterval: 500,
  });
}
