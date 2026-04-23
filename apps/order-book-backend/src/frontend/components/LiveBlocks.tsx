import {
  type LiveBlock,
  type LiveBundle,
  useLiveBlocks,
} from "../hooks/useLiveBlocks";
import { useTps } from "../hooks/useTps";
import { Link } from "../lib/router";
import { MutationDescription } from "./MutationDescription";

function BundleCard({ bundle }: { bundle: LiveBundle }) {
  return (
    <div className="border border-gray-800 rounded px-2 py-2 bg-gray-50 flex flex-col gap-1 h-full overflow-hidden">
      <div className="text-xs text-gray-600 shrink-0">bundle {bundle.id}</div>
      <div className="flex flex-col gap-0.5 overflow-hidden">
        {bundle.mutations.map((m) => (
          <Link
            key={m.id}
            to={`/mutation/${m.id}`}
            className="font-mono text-xs text-gray-800 hover:underline truncate"
          >
            <MutationDescription mutation={m} />
          </Link>
        ))}
      </div>
    </div>
  );
}

function bundleColor(mutationCount: number): string {
  if (mutationCount <= 1) return "bg-blue-200";
  if (mutationCount <= 3) return "bg-blue-300";
  if (mutationCount <= 5) return "bg-blue-400";
  if (mutationCount <= 8) return "bg-blue-500";
  return "bg-blue-600";
}

const BLOCK_INNER_SLOTS = 8;
const BLOCK_INNER_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"];

function BlockCard({ block }: { block: LiveBlock }) {
  const bySlot = new Array<LiveBlock["bundles"][number] | undefined>(
    BLOCK_INNER_SLOTS,
  );
  for (const b of block.bundles) {
    bySlot[b.position % BLOCK_INNER_SLOTS] = b;
  }

  return (
    <Link
      to={`/block/${block.number}`}
      className="border border-gray-800 rounded bg-gray-50 flex flex-col gap-1 h-full overflow-hidden p-2 hover:bg-gray-100"
    >
      <div className="text-xs text-gray-600 shrink-0">block {block.number}</div>
      <div
        className="grid gap-1 flex-1 min-h-0"
        style={{
          gridTemplateColumns: "repeat(4, 1fr)",
          gridTemplateRows: "repeat(2, 1fr)",
        }}
      >
        {BLOCK_INNER_KEYS.map((key, i) => {
          const bundle = bySlot[i];
          return (
            <div
              key={key}
              className={
                bundle
                  ? `${bundleColor(bundle.mutationCount)} rounded-sm`
                  : "border border-dashed border-gray-300 rounded-sm"
              }
            />
          );
        })}
      </div>
    </Link>
  );
}

function EmptyBundleSlot() {
  return (
    <div className="border border-dashed border-gray-300 rounded h-full" />
  );
}

function EmptyBlockSlot() {
  return (
    <div className="border border-dashed border-gray-300 rounded h-full" />
  );
}

export function LiveBlocks() {
  const { bundleSlots, blockSlots } = useLiveBlocks();
  const { data: tps } = useTps();

  return (
    <div className="w-full flex flex-col gap-6 p-4">
      <section>
        <div className="text-xs uppercase tracking-wider text-gray-600 mb-2">
          forming bundles (next block)
        </div>
        <div
          className="border border-black p-3 grid grid-cols-4 grid-rows-2 gap-2"
          style={{ height: 320 }}
        >
          {bundleSlots.map((bundle, i) =>
            bundle ? (
              <BundleCard key={bundle.id} bundle={bundle} />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: slot position is identity
              <EmptyBundleSlot key={`empty-${i}`} />
            ),
          )}
        </div>
      </section>

      <section>
        <div className="text-xs uppercase tracking-wider text-gray-600 mb-2">
          landed blocks{tps != null && <> ({tps.toFixed(1)} tps)</>}
        </div>
        <div
          className="border border-black p-3 grid grid-cols-8 gap-2"
          style={{ height: 160 }}
        >
          {blockSlots.map((block, i) =>
            block ? (
              <BlockCard key={block.hash} block={block} />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: slot position is identity
              <EmptyBlockSlot key={`empty-block-${i}`} />
            ),
          )}
        </div>
      </section>
    </div>
  );
}
