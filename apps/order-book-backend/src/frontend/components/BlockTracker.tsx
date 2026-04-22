import { useEffect, useRef, useState } from "react";
import { type Bundle, type Slot, useBlockStream } from "../hooks/useBlockStream";
import { Link } from "../lib/router";

const BLOCK_SIZE = 40;
const GAP = 12;
const PADDING_X = 12; // px-3 on each side

function bundleColor(mutationCount: number): string {
  if (mutationCount <= 1) return "bg-blue-200";
  if (mutationCount <= 3) return "bg-blue-300";
  if (mutationCount <= 5) return "bg-blue-400";
  if (mutationCount <= 8) return "bg-blue-500";
  return "bg-blue-600";
}

function BlockSquare({
  bundles,
  limbo,
  finalized,
}: {
  bundles: Bundle[];
  limbo: boolean;
  finalized: boolean;
}) {
  const slotKeys = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const slots = slotKeys.map((key, i) => {
    const bundle = bundles[i];
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
      className={`shrink-0 border border-black grid ${limbo ? "border-dashed" : ""} ${finalized ? "border-2" : ""}`}
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
      const inner = containerRef.current.clientWidth - 2 * PADDING_X;
      const n = Math.floor((inner + GAP) / (BLOCK_SIZE + GAP));
      setCapacity(Math.max(0, n));
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const slots = useBlockStream(capacity);

  return (
    <footer
      ref={containerRef}
      className="fixed bottom-0 left-0 right-0 border-t bg-white px-3 py-2 flex items-center"
      style={{ gap: GAP, height: BLOCK_SIZE + 16 }}
    >
      {slots.map((slot: Slot, i) => {
        const finalized = i < slots.length - 2;
        if (slot.kind === "limbo") {
          return (
            <div key="limbo">
              <BlockSquare bundles={slot.bundles} limbo={true} finalized={false} />
            </div>
          );
        }
        return (
          <Link
            key={slot.block.number.toString()}
            to={`/block/${slot.block.number}`}
            className="shrink-0"
          >
            <BlockSquare
              bundles={slot.block.bundles}
              limbo={false}
              finalized={finalized}
            />
          </Link>
        );
      })}
    </footer>
  );
}
