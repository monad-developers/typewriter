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
    <div className="flex items-start">
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
          <div
            key={stage}
            className="flex items-start flex-1 last:flex-none"
          >
            <div className="flex flex-col items-center gap-2 min-w-20">
              <div
                className={`w-4 h-4 rounded-full border-2 ${
                  reached
                    ? "bg-blue-500 border-blue-500"
                    : "bg-white border-gray-300"
                } ${isCurrent ? "ring-2 ring-blue-200 ring-offset-2" : ""}`}
              />
              <code className={reached ? "" : "text-muted-foreground"}>
                {stage}
              </code>
              {ago ? (
                <code className="text-xs text-muted-foreground">{ago}</code>
              ) : null}
            </div>
            {i < STAGES.length - 1 ? (
              <div className="flex-1 flex flex-col items-center mt-1">
                <div
                  className={`w-full h-0.5 ${
                    i < currentIndex ? "bg-blue-500" : "bg-gray-300"
                  }`}
                />
                {segmentMs != null ? (
                  <code className="text-xs text-muted-foreground mt-1">
                    {segmentMs}ms
                  </code>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
