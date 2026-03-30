import { useCallback, useEffect, useRef, useState } from "react";
import { getBlockNumber, watchBlockNumber } from "viem/actions";
import { publicClient } from "../lib/client";

const PRECONFS_PER_BLOCK = 8;
const PRECONF_INTERVAL_MS = 50;

export type PreconfSlot = {
  tradeCount: number;
};

export type Block = {
  number: bigint;
  preconfs: PreconfSlot[];
  totalTrades: number;
};

/** A block is complete when all 8 preconfs have arrived. */
export function isComplete(block: Block): boolean {
  return block.preconfs.length >= PRECONFS_PER_BLOCK;
}

/**
 * A block is finalized when 2 subsequent complete blocks exist after it.
 * `completeAfter` = number of consecutive complete blocks following this one.
 */
export function isFinalized(blocks: Block[], index: number): boolean {
  let count = 0;
  for (let i = index + 1; i < blocks.length && count < 2; i++) {
    const b = blocks[i];
    if (b && isComplete(b)) count++;
    else break;
  }
  return count >= 2;
}

export function useBlockStream(capacity: number) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const lastBlockRef = useRef<bigint | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const addBlock = useCallback(
    (blockNumber: bigint) => {
      if (lastBlockRef.current !== null && blockNumber <= lastBlockRef.current) return;
      lastBlockRef.current = blockNumber;

      // Simulate preconf slots filling in over time
      // TODO: derive tradeCount from actual mutation queue activity
      const preconfs: PreconfSlot[] = Array.from({ length: PRECONFS_PER_BLOCK }, () => ({
        tradeCount: Math.random() < 0.4 ? 0 : Math.floor(Math.random() * 8) + 1,
      }));

      setBlocks((prev) => {
        const next: Block[] = [...prev, { number: blockNumber, preconfs: [], totalTrades: 0 }];
        if (next.length > capacity && capacity > 0) return next.slice(-1);
        return next;
      });

      // Stagger preconf arrivals
      for (let i = 0; i < PRECONFS_PER_BLOCK; i++) {
        const timer = setTimeout(() => {
          setBlocks((prev) => {
            const idx = prev.findIndex((b) => b.number === blockNumber);
            if (idx === -1) return prev;
            const block = prev[idx];
            if (!block || block.preconfs.length >= PRECONFS_PER_BLOCK) return prev;
            const slot = preconfs[block.preconfs.length];
            if (!slot) return prev;
            const updated: Block = {
              number: block.number,
              preconfs: [...block.preconfs, slot],
              totalTrades: block.totalTrades + slot.tradeCount,
            };
            const next = [...prev];
            next[idx] = updated;
            return next;
          });
        }, (i + 1) * PRECONF_INTERVAL_MS);
        timersRef.current.push(timer);
      }
    },
    [capacity],
  );

  useEffect(() => {
    getBlockNumber(publicClient).then(addBlock);
    const unwatch = watchBlockNumber(publicClient, {
      onBlockNumber: addBlock,
      pollingInterval: 200,
    });
    return () => {
      unwatch();
      for (const t of timersRef.current) clearTimeout(t);
      timersRef.current = [];
    };
  }, [addBlock]);

  // Reset when capacity changes (e.g. window resize) and blocks overflow
  useEffect(() => {
    if (capacity > 0 && blocks.length > capacity) {
      setBlocks([]);
    }
  }, [capacity, blocks.length]);

  return blocks;
}
