import { useEffect, useRef, useState } from "react";
import { type Block, useBlockStream } from "../hooks/useBlockStream";

const BLOCK_SIZE = 40;
const GAP = 12;
function bundleColor(mutationCount: number): string {
  if (mutationCount <= 1) return "bg-blue-200";
  if (mutationCount <= 3) return "bg-blue-300";
  if (mutationCount <= 5) return "bg-blue-400";
  if (mutationCount <= 8) return "bg-blue-500";
  return "bg-blue-600";
}

function BlockSquare({
  block,
  finalized,
}: {
  block: Block;
  finalized: boolean;
}) {
  const slotKeys = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const slots = slotKeys.map((key, i) => {
    const bundle = block.bundles[i];
    return (
      <div
        key={key}
        className={bundle ? bundleColor(bundle.mutationCount) : "bg-gray-50"}
        style={{
          opacity: bundle ? 1 : 0.3,
          transform: bundle ? "scale(1)" : "scale(0.6)",
        }}
      />
    );
  });

  return (
    <div
      className={`shrink-0 border border-black grid ${block.pending ? "border-dashed" : ""} ${finalized ? "border-2" : ""}`}
      style={{
        width: BLOCK_SIZE,
        height: BLOCK_SIZE,
        gridTemplateColumns: "repeat(4, 1fr)",
        gridTemplateRows: "repeat(2, 1fr)",
      }}
    >
      {slots}
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
        <BlockSquare
          key={block.pending ? "pending" : block.number.toString()}
          block={block}
          finalized={!block.pending && i < blocks.length - 2}
        />
      ))}
    </footer>
  );
}
