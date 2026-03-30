import { useEffect, useRef, useState } from "react";
import { type Block, isFinalized, useBlockStream } from "../hooks/useBlockStream";

const BLOCK_SIZE = 40;
const GAP = 12;

function activityColor(tradeCount: number): string {
  if (tradeCount === 0) return "bg-gray-200";
  if (tradeCount <= 2) return "bg-blue-300";
  if (tradeCount <= 5) return "bg-blue-500";
  return "bg-blue-600";
}

function BlockSquare({ block, finalized }: { block: Block; finalized: boolean }) {
  const slotKeys = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const cells = slotKeys.map((slotKey, i) => {
    const filled = i < block.preconfs.length;
    const slot = filled ? block.preconfs[i] : undefined;
    return (
      <div
        key={slotKey}
        className={` ${
          filled && slot ? activityColor(slot.tradeCount) : "bg-gray-50"
        }`}
        style={{
          transform: filled ? "scale(1)" : "scale(0.6)",
          opacity: filled ? 1 : 0.3,
        }}
      />
    );
  });

  return (
    <div
      className={`shrink-0 border border-black grid ${finalized ? "border-2" : ""}`}
      style={{
        width: BLOCK_SIZE,
        height: BLOCK_SIZE,
        gridTemplateColumns: "repeat(4, 1fr)",
        gridTemplateRows: "repeat(2, 1fr)",
      }}
    >
      {cells}
    </div>
  );
}

export function BlockTracker() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(0);

  useEffect(() => {
    function measure() {
      if (!containerRef.current) return;
      const width = containerRef.current.clientWidth;
      setCapacity(Math.floor(width / (BLOCK_SIZE + GAP)));
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const blocks = useBlockStream(capacity);

  return (
    <footer
      ref={containerRef}
      className="fixed bottom-0 left-0 right-0 border-t bg-white px-3 py-2 flex items-center"
      style={{ gap: GAP, height: BLOCK_SIZE + 16 }}
    >
      {blocks.map((block, i) => (
        <BlockSquare key={block.number.toString()} block={block} finalized={isFinalized(blocks, i)} />
      ))}
    </footer>
  );
}
