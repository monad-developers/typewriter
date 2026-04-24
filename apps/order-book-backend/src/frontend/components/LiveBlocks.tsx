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
  if (mutationCount <= 1) return "bg-slate-300";
  if (mutationCount <= 3) return "bg-slate-400";
  if (mutationCount <= 5) return "bg-slate-600";
  if (mutationCount <= 8) return "bg-slate-800";
  return "bg-slate-900";
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
      className="border border-border rounded-xl bg-muted/30 hover:bg-muted hover:border-foreground/30 transition-all flex flex-col gap-2 h-full overflow-hidden p-3"
    >
      <div className="text-xs font-mono tabular-nums text-muted-foreground shrink-0 truncate">
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
                  ? `${bundleColor(bundle.mutationCount)} rounded-[3px]`
                  : "bg-muted/60 rounded-[3px]"
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
    <div className="border border-dashed border-muted-foreground/40 rounded-xl bg-muted/20 flex flex-col gap-2 h-full overflow-hidden p-3">
      <div className="text-xs text-muted-foreground shrink-0 truncate">
        Accepted
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
                ? `${bundleColor(bundle.mutations.length)} rounded-[3px]`
                : "bg-muted/60 rounded-[3px]"
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
    <div className="w-full border-t border-border px-8 py-8">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h3 className="text-base font-semibold tracking-tight">
            Activity stream
          </h3>
          {tps != null && (
            <span className="text-sm font-mono tabular-nums text-muted-foreground">
              {tps.toFixed(1)} tps
            </span>
          )}
        </div>
        {isPaused && (
          <span
            title="paused"
            className="inline-flex items-center gap-0.5 text-muted-foreground"
          >
            <span className="inline-block w-[3px] h-[10px] bg-current" />
            <span className="inline-block w-[3px] h-[10px] bg-current" />
          </span>
        )}
      </div>
      <div
        className="grid gap-3"
        style={{
          height: 260,
          gridTemplateColumns: `minmax(0, 1fr) repeat(${BLOCK_QUEUE_SIZE}, minmax(0, 1fr))`,
        }}
      >
        <FormingBlockColumn bundleSlots={bundleSlots} />
        <section
          aria-label="landed blocks"
          onPointerEnter={() => handleHoverChange(true)}
          onPointerLeave={() => handleHoverChange(false)}
          className="grid gap-3 h-full"
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
