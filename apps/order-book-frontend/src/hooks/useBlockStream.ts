import { useCallback, useEffect, useRef, useState } from "react";

export type Bundle = {
  mutationCount: number;
};

export type Block = {
  number: bigint;
  hash: string;
  timestamp: bigint;
  bundles: Bundle[];
  pending: boolean;
};

export function useBlockStream(capacity: number) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const capacityRef = useRef(capacity);
  capacityRef.current = capacity;

  const addBundle = useCallback((mutationCount: number) => {
    setBlocks((prev) => {
      const last = prev[prev.length - 1];
      if (last?.pending) {
        const next = [...prev];
        next[next.length - 1] = {
          ...last,
          bundles: [...last.bundles, { mutationCount }],
        };
        return next;
      }
      return [
        ...prev,
        {
          number: 0n,
          hash: "",
          timestamp: 0n,
          bundles: [{ mutationCount }],
          pending: true,
        },
      ];
    });
  }, []);

  const addBlock = useCallback(
    (number: bigint, hash: string, timestamp: bigint) => {
      setBlocks((prev) => {
        const last = prev[prev.length - 1];
        if (last?.number && last.number >= number) return prev;
        const cap = capacityRef.current;
        if (last?.pending) {
          const next = [...prev];
          next[next.length - 1] = {
            ...last,
            number,
            hash,
            timestamp,
            pending: false,
          };
          if (cap > 0 && next.length > cap) return next.slice(-1);
          return next;
        }
        const block: Block = {
          number,
          hash,
          timestamp,
          bundles: [],
          pending: false,
        };
        if (cap > 0 && prev.length >= cap) return [block];
        return [...prev, block];
      });
    },
    [],
  );

  useEffect(() => {
    const blockSource = new EventSource("/api/events/blocks");
    const bundleSource = new EventSource("/api/events/bundles");

    blockSource.addEventListener("block", (e) => {
      const data = JSON.parse(e.data);
      addBlock(BigInt(data.number), data.hash, BigInt(data.timestamp));
    });

    bundleSource.addEventListener("bundle", (e) => {
      const data = JSON.parse(e.data);
      if (data.status === "accepted") {
        addBundle(data.mutationIds.length);
      }
    });

    return () => {
      blockSource.close();
      bundleSource.close();
    };
  }, [addBlock, addBundle]);

  return blocks;
}
