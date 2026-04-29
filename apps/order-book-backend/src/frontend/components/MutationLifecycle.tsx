import type { MutationStatus } from "../hooks/useMutations";

const STAGES: MutationStatus[] = [
  "pending",
  "accepted",
  "proposed",
  "voted",
  "finalized",
  "verified",
];

export type StageTimestamps = Partial<Record<MutationStatus, string>>;

function durationMs(a: string, b: string): number {
  return new Date(b).getTime() - new Date(a).getTime();
}

function relativeMs(ms: number): string {
  if (ms < 1000) return `${ms}ms ago`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function MutationLifecycle({
  status,
  timestamps,
}: {
  status: MutationStatus | undefined;
  timestamps: StageTimestamps | undefined;
}) {
  const currentIndex = status ? STAGES.indexOf(status) : -1;

  return (
    <div className="flex items-start text-sm">
      {STAGES.map((stage, i) => {
        const reached = i <= currentIndex;
        const isCurrent = i === currentIndex;
        const stageTime = timestamps?.[stage];
        const nextStage = STAGES[i + 1];
        const nextStageTime = nextStage ? timestamps?.[nextStage] : undefined;
        const segmentMs =
          stageTime && nextStageTime
            ? durationMs(stageTime, nextStageTime)
            : null;

        const ago =
          isCurrent && stageTime
            ? relativeMs(Date.now() - new Date(stageTime).getTime())
            : null;

        return (
          <div key={stage} className="flex items-start flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-2 min-w-20">
              <div
                className={`w-3 h-3 border border-black ${
                  reached ? "bg-blue-500" : "bg-white"
                } ${isCurrent ? "ring-2 ring-blue-500 ring-offset-1" : ""}`}
              />
              <span className={reached ? "" : "text-zinc-400"}>{stage}</span>
              {ago ? (
                <span className="text-xs text-zinc-500 tabular-nums">
                  {ago}
                </span>
              ) : null}
            </div>
            {i < STAGES.length - 1 ? (
              <div className="flex-1 flex flex-col items-center mt-[5px]">
                <div
                  className={`w-full h-px ${
                    i < currentIndex ? "bg-blue-500" : "bg-zinc-300"
                  }`}
                />
                {segmentMs != null ? (
                  <span className="text-xs text-zinc-500 tabular-nums mt-1">
                    {segmentMs}ms
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
