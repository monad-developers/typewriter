import { useEffect, useState } from "react";
import superjson from "superjson";
import type { Hex } from "viem";

export type LiveBatch = {
  id: number;
  position: number;
  mutations: unknown[];
};

export type LiveBlockBatch = {
  id: number;
  position: number;
  mutationCount: number;
};

export type LiveBlock = {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
  batches: LiveBlockBatch[];
};

export const BATCH_SLOT_COUNT = 8;
export const BLOCK_QUEUE_SIZE = 8;

export function useLiveBlocks(): {
  batchSlots: (LiveBatch | null)[];
  blocks: LiveBlock[];
} {
  const [batchSlots, setBatchSlots] = useState<(LiveBatch | null)[]>(() =>
    Array(BATCH_SLOT_COUNT).fill(null),
  );
  const [blocks, setBlocks] = useState<LiveBlock[]>([]);

  useEffect(() => {
    const blockSource = new EventSource("/api/events/blocks");
    const batchSource = new EventSource("/api/events/batches");

    batchSource.addEventListener("batch", (e) => {
      const data = superjson.parse(e.data) as {
        id: number;
        status: string;
        position: number;
        mutations: unknown[];
      };
      if (data.status !== "accepted") return;
      setBatchSlots((prev) => {
        const next = prev.slice();
        next[data.position % BATCH_SLOT_COUNT] = {
          id: data.id,
          position: data.position,
          mutations: data.mutations,
        };
        return next;
      });
    });

    blockSource.addEventListener("block", (e) => {
      const data = superjson.parse(e.data) as {
        status: string;
        number?: bigint;
        hash?: Hex;
        timestamp?: bigint;
        batches?: {
          id: number;
          position: number;
          mutations?: unknown[];
        }[];
      };
      if (data.status === "included") {
        setBatchSlots(Array(BATCH_SLOT_COUNT).fill(null));

        if (data.number == null || data.hash == null || data.timestamp == null)
          return;
        const block: LiveBlock = {
          number: data.number,
          hash: data.hash,
          timestamp: data.timestamp,
          batches: (data.batches ?? []).map((batch) => ({
            id: batch.id,
            position: batch.position,
            mutationCount: batch.mutations?.length ?? 0,
          })),
        };
        setBlocks((prev) => {
          if (prev.some((b) => b.hash === block.hash)) return prev;
          const next = [block, ...prev];
          if (next.length > BLOCK_QUEUE_SIZE) next.length = BLOCK_QUEUE_SIZE;
          return next;
        });
      }
    });

    return () => {
      blockSource.close();
      batchSource.close();
    };
  }, []);

  return { batchSlots, blocks };
}
