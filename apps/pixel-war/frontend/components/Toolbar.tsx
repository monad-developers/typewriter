import {
  colorsForTeam,
  PALETTE,
  TOOL_COST,
  TOOLS,
  type Tool,
} from "pixel-war-sdk";

type Props = {
  tool: Tool;
  onTool: (tool: Tool) => void;
  color: number;
  onColor: (color: number) => void;
  team: number;
  energy: number;
};

const TOOL_HINT: Record<Tool, string> = {
  paint: "take one pixel",
  shield: "absorb the next hit on your pixel",
  bomb: "repaint a 3x3, shields still absorb",
};

export function Toolbar({ tool, onTool, color, onColor, team, energy }: Props) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {TOOLS.map((entry) => {
          const affordable = energy >= TOOL_COST[entry];
          return (
            <button
              key={entry}
              type="button"
              onClick={() => onTool(entry)}
              className={`flex-1 border px-2 py-2 text-left text-xs ${
                tool === entry
                  ? "border-ink bg-panel"
                  : "border-edge hover:border-dim"
              } ${affordable ? "" : "opacity-40"}`}
            >
              <div className="flex items-center justify-between">
                <span className="uppercase tracking-wide">{entry}</span>
                <span className="tabular-nums text-dim">
                  {TOOL_COST[entry]}
                </span>
              </div>
              <div className="mt-1 text-[10px] leading-tight text-dim">
                {TOOL_HINT[entry]}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-dim">shade</span>
        {colorsForTeam(team).map((entry) => (
          <button
            key={entry}
            type="button"
            aria-label={`color ${entry}`}
            onClick={() => onColor(entry)}
            style={{ background: PALETTE[entry] }}
            className={`h-7 w-7 border-2 ${
              color === entry ? "border-ink" : "border-edge"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
