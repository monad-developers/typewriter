import { useEffect, useState } from "react";

export function EnergyBar({
  energy,
  maxEnergy,
}: {
  energy: number;
  maxEnergy: number;
}) {
  const ticks = Array.from({ length: maxEnergy }, (_, index) => index);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs text-dim">
        <span className="uppercase tracking-wide">energy</span>
        <span className="tabular-nums">
          {energy}/{maxEnergy}
        </span>
      </div>
      <div className="flex gap-[2px]">
        {ticks.map((tick) => (
          <span
            key={tick}
            className={`h-3 flex-1 ${tick < energy ? "bg-ink" : "bg-edge"}`}
          />
        ))}
      </div>
    </div>
  );
}

/// Counts down to the next epoch. The epoch only moves when the server's
/// `AdvanceEpoch` mutation lands, so this is a prediction of the next tick, not a
/// consensus clock.
export function EpochClock({
  epoch,
  epochStartedAt,
  epochIntervalMs,
}: {
  epoch: number;
  epochStartedAt: number;
  epochIntervalMs: number;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);

  const remaining = Math.max(
    0,
    Math.ceil((epochStartedAt + epochIntervalMs - now) / 1000),
  );

  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="uppercase tracking-wide text-dim">epoch</span>
      <span className="tabular-nums">{epoch}</span>
      <span className="tabular-nums text-dim">refill in {remaining}s</span>
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col border border-edge px-2 py-1">
      <span className="text-[10px] uppercase tracking-wide text-dim">
        {label}
      </span>
      <span className="tabular-nums text-sm">{value}</span>
      {hint !== undefined && (
        <span className="text-[10px] text-dim">{hint}</span>
      )}
    </div>
  );
}
