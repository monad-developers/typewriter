import { useQuery } from "@tanstack/react-query";
import type { Hex } from "viem";
import { request } from "../lib/api";

export type LiveBatch = {
  id: number;
  position: number;
  mutationCount: number;
};

export type LiveBlock = {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
  batches: LiveBatch[];
};

export function useLiveBlocks() {
  return useQuery({
    queryKey: ["liveBlocks"],
    queryFn: () =>
      request<{ acceptedBatches: LiveBatch[]; includedBlocks: LiveBlock[] }>(
        "/api/live-blocks",
      ),
    refetchInterval: 100,
  });
}
