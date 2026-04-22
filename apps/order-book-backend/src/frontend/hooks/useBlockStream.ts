import { useEffect, useRef, useState } from "react";

export type Bundle = {
  id: number;
  mutationCount: number;
};

type BlockMeta = {
  number: bigint;
  hash: string;
  timestamp: bigint;
  bundleIds: number[];
};

export type Block = BlockMeta & { bundles: Bundle[] };

export type Slot =
  | { kind: "block"; block: Block }
  | { kind: "limbo"; bundles: Bundle[] };

export function useBlockStream(capacity: number): Slot[] {
  const [bundlesById, setBundlesById] = useState<Map<number, Bundle>>(
    () => new Map(),
  );
  const [blockMetas, setBlockMetas] = useState<BlockMeta[]>([]);
  const capacityRef = useRef(capacity);
  capacityRef.current = capacity;

  useEffect(() => {
    const blockSource = new EventSource("/api/events/blocks");
    const bundleSource = new EventSource("/api/events/bundles");

    blockSource.addEventListener("block", (e) => {
      const data = JSON.parse(e.data) as {
        number: string;
        hash: string;
        timestamp: string;
        bundleIds: number[];
      };
      const number = BigInt(data.number);
      setBlockMetas((prev) => {
        if (prev.some((b) => b.number === number)) return prev;
        const next = [
          ...prev,
          {
            number,
            hash: data.hash,
            timestamp: BigInt(data.timestamp),
            bundleIds: data.bundleIds,
          },
        ];
        const cap = capacityRef.current;
        if (cap > 0 && next.length > cap) return next.slice(-cap);
        return next;
      });
    });

    bundleSource.addEventListener("bundle", (e) => {
      const data = JSON.parse(e.data) as {
        id: number;
        status: string;
        mutationIds: number[];
      };
      if (data.status !== "accepted") return;
      setBundlesById((prev) => {
        if (prev.has(data.id)) return prev;
        const next = new Map(prev);
        next.set(data.id, {
          id: data.id,
          mutationCount: data.mutationIds.length,
        });
        return next;
      });
    });

    return () => {
      blockSource.close();
      bundleSource.close();
    };
  }, []);

  const claimed = new Set<number>();
  const blocks: Block[] = blockMetas.map((meta) => {
    const bundles: Bundle[] = [];
    for (const id of meta.bundleIds) {
      const b = bundlesById.get(id);
      if (b) {
        bundles.push(b);
        claimed.add(id);
      }
    }
    return { ...meta, bundles };
  });

  const limbo: Bundle[] = [];
  for (const [id, bundle] of bundlesById) {
    if (!claimed.has(id)) limbo.push(bundle);
  }
  limbo.sort((a, b) => a.id - b.id);

  const cap = capacity;
  const reserved = limbo.length > 0 ? 1 : 0;
  const maxBlocks = cap > 0 ? Math.max(0, cap - reserved) : blocks.length;
  const visibleBlocks = blocks.slice(-maxBlocks);

  const slots: Slot[] = visibleBlocks.map((block) => ({
    kind: "block",
    block,
  }));
  if (limbo.length > 0) slots.push({ kind: "limbo", bundles: limbo });
  return slots;
}
