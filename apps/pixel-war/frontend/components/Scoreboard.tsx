import { PIXEL_COUNT, TEAMS } from "pixel-war-sdk";

type Props = {
  teamPixels: number[];
  team: number | null;
};

export function Scoreboard({ teamPixels, team }: Props) {
  const painted = teamPixels.reduce((total, value) => total + value, 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-xs text-dim">
        <span className="uppercase tracking-wide">canvas share</span>
        <span className="tabular-nums">
          {painted}/{PIXEL_COUNT}
        </span>
      </div>
      <div className="flex h-3 w-full overflow-hidden border border-edge">
        {TEAMS.map((entry) => (
          <div
            key={entry.id}
            style={{
              background: entry.hex[1],
              width: `${((teamPixels[entry.id] ?? 0) / PIXEL_COUNT) * 100}%`,
            }}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1 text-xs">
        {TEAMS.map((entry) => (
          <div key={entry.id} className="flex items-center gap-2">
            <span
              className="h-3 w-3 border border-edge"
              style={{ background: entry.hex[1] }}
            />
            <span className={team === entry.id ? "text-ink" : "text-dim"}>
              {entry.name}
              {team === entry.id ? " (you)" : ""}
            </span>
            <span className="ml-auto tabular-nums text-dim">
              {teamPixels[entry.id] ?? 0}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
