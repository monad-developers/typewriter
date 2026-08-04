import { PALETTE } from "pixel-war-sdk";
import type { ActivityEvent } from "../hooks/useActivity";

/// The mutation lifecycle, in order. A row lights up as far as the server has
/// taken it: accepted locally in milliseconds, then included in a block, then
/// safe, then finalized.
const LIFECYCLE = ["accepted", "included", "safe", "finalized"] as const;

function stageOf(status: string): number {
  const index = LIFECYCLE.indexOf(status as (typeof LIFECYCLE)[number]);
  return index === -1 ? 0 : index;
}

function Lifecycle({ status }: { status: string }) {
  if (status === "rejected") {
    return <span className="text-[10px] text-red-400">rejected</span>;
  }
  const stage = stageOf(status);
  return (
    <span className="flex items-center gap-0.5" title={status}>
      {LIFECYCLE.map((entry, index) => (
        <span
          key={entry}
          className={`h-1.5 w-3 ${index <= stage ? "bg-ink" : "bg-edge"}`}
        />
      ))}
    </span>
  );
}

export function ActivityFeed({
  events,
  dropped,
  account,
}: {
  events: ActivityEvent[];
  dropped: number;
  account: string | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-xs text-dim">
        <span className="uppercase tracking-wide">mutations</span>
        {dropped > 0 && <span>{dropped} not shown</span>}
      </div>
      <div className="flex flex-col gap-1 text-xs">
        {events.length === 0 && (
          <span className="text-dim">waiting for activity…</span>
        )}
        {events.map((event) => (
          <div
            key={event.id}
            className={`flex items-center gap-2 border-b border-edge/60 pb-1 ${
              event.account === account ? "text-ink" : "text-dim"
            }`}
          >
            <span className="tabular-nums w-10 shrink-0">#{event.id}</span>
            {event.color === null ? (
              <span className="h-3 w-3 shrink-0 border border-edge" />
            ) : (
              <span
                className="h-3 w-3 shrink-0 border border-edge"
                style={{ background: PALETTE[event.color] }}
              />
            )}
            <span className="w-12 shrink-0">{event.name.toLowerCase()}</span>
            <span className="tabular-nums shrink-0">
              {event.x === null ? "" : `${event.x},${event.y}`}
            </span>
            {event.isForceInclusion && (
              <span className="shrink-0 text-amber-400" title="force included">
                forced
              </span>
            )}
            <span className="ml-auto shrink-0">
              <Lifecycle status={event.status} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
