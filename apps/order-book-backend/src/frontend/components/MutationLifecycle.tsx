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
                className={`w-3 h-3 rounded-full border-2 transition-all ${
                  reached
                    ? "bg-indigo-600 border-indigo-600"
                    : "bg-background border-border"
                } ${isCurrent ? "ring-4 ring-indigo-100 scale-110" : ""}`}
              />
              <div className="flex flex-col items-center gap-0.5">
                <span
                  className={`text-xs uppercase tracking-wider font-semibold ${reached ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {stage}
                </span>
                {ago ? (
                  <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
                    {ago}
                  </span>
                ) : null}
              </div>
            </div>
            {i < STAGES.length - 1 ? (
              <div className="flex-1 flex flex-col items-center mt-[5px]">
                <div
                  className={`w-full h-px ${
                    i < currentIndex ? "bg-indigo-600" : "bg-border"
                  }`}
                />
                {segmentMs != null ? (
                  <span className="text-[11px] font-mono tabular-nums text-muted-foreground mt-1">
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
