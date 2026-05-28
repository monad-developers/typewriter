import { useEffect, useState } from "react";
import type { Hex } from "viem";
import type {
  AddInstrumentPayload,
  AuthorizePayload,
  CloseOrderPayload,
  DepositPayload,
  InitializePayload,
  LimitOrderPayload,
  MarketOrderPayload,
  RevokePayload,
  WithdrawalPayload,
} from "./useMutations";

type StreamMutationBase = {
  id: number;
  account: Hex;
  keyIndex: string | null;
  nonce: string | null;
  deadline: string;
};

export type BatchMutation =
  | (StreamMutationBase & { type: "initialize"; payload: InitializePayload })
  | (StreamMutationBase & { type: "authorize"; payload: AuthorizePayload })
  | (StreamMutationBase & { type: "revoke"; payload: RevokePayload })
  | (StreamMutationBase & { type: "closeOrder"; payload: CloseOrderPayload })
  | (StreamMutationBase & { type: "limitOrder"; payload: LimitOrderPayload })
  | (StreamMutationBase & { type: "marketOrder"; payload: MarketOrderPayload })
  | (StreamMutationBase & {
      type: "addInstrument";
      payload: AddInstrumentPayload;
    })
  | (StreamMutationBase & { type: "deposit"; payload: DepositPayload })
  | (StreamMutationBase & { type: "withdrawal"; payload: WithdrawalPayload });

export type LiveBatch = {
  id: number;
  position: number;
  mutations: BatchMutation[];
};

export type LiveBlockBatch = {
  id: number;
  position: number;
  mutationCount: number;
};

export type LiveBlock = {
  number: string;
  hash: Hex;
  timestamp: string;
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
      const data = JSON.parse(e.data) as {
        id: number;
        status: string;
        position: number;
        mutations: BatchMutation[];
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
      const data = JSON.parse(e.data) as {
        status: string;
        number?: string;
        hash?: Hex;
        timestamp?: string;
        batches?: LiveBlockBatch[];
      };
      if (data.status === "included") {
        setBatchSlots(Array(BATCH_SLOT_COUNT).fill(null));

        if (data.number == null || data.hash == null || data.timestamp == null)
          return;
        const block: LiveBlock = {
          number: data.number,
          hash: data.hash,
          timestamp: data.timestamp,
          batches: data.batches ?? [],
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
