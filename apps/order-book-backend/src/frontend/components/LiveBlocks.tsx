import { useState } from "react";
import {
  BLOCK_QUEUE_SIZE,
  type LiveBlock,
  type LiveBundle,
  useLiveBlocks,
} from "../hooks/useLiveBlocks";
import { useTps } from "../hooks/useTps";
import { Link } from "../lib/router";

function bundleColor(mutationCount: number): string {
  if (mutationCount <= 1) return "bg-sky-200";
  if (mutationCount <= 3) return "bg-sky-300";
  if (mutationCount <= 5) return "bg-sky-400";
  if (mutationCount <= 8) return "bg-sky-500";
  return "bg-sky-600";
}

const BLOCK_INNER_SLOTS = 8;
const BLOCK_INNER_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"];

function BlockColumn({ block }: { block: LiveBlock }) {
  const bySlot = new Array<LiveBlock["bundles"][number] | undefined>(
    BLOCK_INNER_SLOTS,
  );
  for (const b of block.bundles) {
    bySlot[b.position % BLOCK_INNER_SLOTS] = b;
  }

  return (
    <Link
      to={`/block/${block.number}`}
      className="border border-border rounded-[3px] bg-muted/40 hover:bg-muted transition-colors flex flex-col gap-1.5 h-full overflow-hidden p-2"
    >
      <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground shrink-0 truncate tabular-nums">
        {block.number}
      </div>
      <div
        className="grid gap-1 flex-1 min-h-0"
        style={{
          gridTemplateColumns: "1fr",
          gridTemplateRows: `repeat(${BLOCK_INNER_SLOTS}, 1fr)`,
        }}
      >
        {BLOCK_INNER_KEYS.map((key, i) => {
          const bundle = bySlot[i];
          return (
            <div
              key={key}
              className={
                bundle
                  ? `${bundleColor(bundle.mutationCount)} rounded-[2px]`
                  : "border border-dashed border-border rounded-[2px]"
              }
            />
          );
        })}
      </div>
    </Link>
  );
}

function FormingBlockColumn({
  bundleSlots,
}: {
  bundleSlots: (LiveBundle | null)[];
}) {
  return (
    <div className="border border-dashed border-muted-foreground/60 rounded-[3px] bg-muted/40 flex flex-col gap-1.5 h-full overflow-hidden p-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground shrink-0 truncate">
        accepted
      </div>
      <div
        className="grid gap-1 flex-1 min-h-0"
        style={{
          gridTemplateColumns: "1fr",
          gridTemplateRows: `repeat(${BLOCK_INNER_SLOTS}, 1fr)`,
        }}
      >
        {bundleSlots.map((bundle, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: slot position is identity
            key={i}
            className={
              bundle
                ? `${bundleColor(bundle.mutations.length)} rounded-[2px]`
                : "border border-dashed border-border rounded-[2px]"
            }
          />
        ))}
      </div>
    </div>
  );
}

export function LiveBlocks() {
  const { bundleSlots, blocks } = useLiveBlocks();
  const { data: tps } = useTps();
  const [frozenBlocks, setFrozenBlocks] = useState<LiveBlock[] | null>(null);

  const displayBlocks = frozenBlocks ?? blocks;
  const isPaused = frozenBlocks !== null;

  const handleHoverChange = (hovered: boolean) => {
    if (hovered) {
      setFrozenBlocks((prev) => prev ?? blocks);
    } else {
      setFrozenBlocks(null);
    }
  };

  return (
    <div className="w-full border-t border-border px-6 py-5">
      <div className="mb-3 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="font-semibold">activity stream</span>
          {tps != null && (
            <span className="tabular-nums normal-case tracking-normal">
              {tps.toFixed(1)} tps
            </span>
          )}
        </div>
        {isPaused && (
          <span
            title="paused"
            className="inline-flex items-center gap-0.5 text-muted-foreground normal-case tracking-normal"
          >
            <span className="inline-block w-[3px] h-[10px] bg-current" />
            <span className="inline-block w-[3px] h-[10px] bg-current" />
          </span>
        )}
      </div>
      <div
        className="border border-border rounded-[4px] p-3 grid gap-2 bg-background"
        style={{
          height: 240,
          gridTemplateColumns: `minmax(0, 1fr) repeat(${BLOCK_QUEUE_SIZE}, minmax(0, 1fr))`,
        }}
      >
        <FormingBlockColumn bundleSlots={bundleSlots} />
        <section
          aria-label="landed blocks"
          onPointerEnter={() => handleHoverChange(true)}
          onPointerLeave={() => handleHoverChange(false)}
          className="grid gap-2 h-full"
          style={{
            gridColumn: `span ${BLOCK_QUEUE_SIZE}`,
            gridTemplateColumns: `repeat(${BLOCK_QUEUE_SIZE}, minmax(0, 1fr))`,
          }}
        >
          {displayBlocks.map((block) => (
            <BlockColumn key={block.hash} block={block} />
          ))}
        </section>
      </div>
    </div>
  );
}
