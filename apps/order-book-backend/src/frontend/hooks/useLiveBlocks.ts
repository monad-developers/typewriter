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

export type BundleMutation =
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

export type LiveBundle = {
  id: number;
  position: number;
  mutations: BundleMutation[];
};

export type LiveBlockBundle = {
  id: number;
  position: number;
  mutationCount: number;
};

export type LiveBlock = {
  number: string;
  hash: Hex;
  timestamp: string;
  bundles: LiveBlockBundle[];
};

export const BUNDLE_SLOT_COUNT = 8;
export const BLOCK_SLOT_COUNT = 8;

export function useLiveBlocks(): {
  bundleSlots: (LiveBundle | null)[];
  blockSlots: (LiveBlock | null)[];
} {
  const [bundleSlots, setBundleSlots] = useState<(LiveBundle | null)[]>(() =>
    Array(BUNDLE_SLOT_COUNT).fill(null),
  );
  const [blockSlots, setBlockSlots] = useState<(LiveBlock | null)[]>(() =>
    Array(BLOCK_SLOT_COUNT).fill(null),
  );

  useEffect(() => {
    const blockSource = new EventSource("/api/events/blocks");
    const bundleSource = new EventSource("/api/events/bundles");

    bundleSource.addEventListener("bundle", (e) => {
      const data = JSON.parse(e.data) as {
        id: number;
        status: string;
        position: number;
        mutations: BundleMutation[];
      };
      if (data.status !== "accepted") return;
      setBundleSlots((prev) => {
        const next = prev.slice();
        next[data.position % BUNDLE_SLOT_COUNT] = {
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
        bundles?: LiveBlockBundle[];
      };
      if (data.status === "accepted") {
        setBundleSlots(Array(BUNDLE_SLOT_COUNT).fill(null));
        return;
      }
      if (data.status === "proposed") {
        if (data.number == null || data.hash == null || data.timestamp == null)
          return;
        const block: LiveBlock = {
          number: data.number,
          hash: data.hash,
          timestamp: data.timestamp,
          bundles: data.bundles ?? [],
        };
        const num = BigInt(block.number);
        const idx = Number(num % BigInt(BLOCK_SLOT_COUNT));
        setBlockSlots((prev) => {
          let shouldClear = false;
          for (let i = idx; i < BLOCK_SLOT_COUNT; i++) {
            const existing = prev[i];
            if (existing) {
              shouldClear = true;
              break;
            }
          }

          for (let i = 0; i < idx; i++) {
            const existing = prev[i];
            if (
              existing &&
              num - BigInt(existing.number) >= BigInt(BLOCK_SLOT_COUNT)
            ) {
              shouldClear = true;
              break;
            }
          }

          const next = shouldClear
            ? Array(BLOCK_SLOT_COUNT).fill(null)
            : prev.slice();
          next[idx] = block;
          return next;
        });
      }
    });

    return () => {
      blockSource.close();
      bundleSource.close();
    };
  }, []);

  return { bundleSlots, blockSlots };
}
