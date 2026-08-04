import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  bombFootprint,
  colorsForTeam,
  TOOL_COST,
  type Tool,
  teamName,
  teamOfColor,
  toPixelIndex,
} from "pixel-war-sdk";
import { useEffect, useMemo, useState } from "react";
import { ActivityFeed } from "./components/ActivityFeed";
import { CanvasView } from "./components/CanvasView";
import { EnergyBar, EpochClock, Stat } from "./components/Hud";
import { Rules } from "./components/Rules";
import { Scoreboard } from "./components/Scoreboard";
import { SignIn } from "./components/SignIn";
import { Toolbar } from "./components/Toolbar";
import { AccountProvider, useAccountContext } from "./contexts/AccountContext";
import { DomainProvider } from "./contexts/DomainContext";
import { useAccountState } from "./hooks/useAccountState";
import { useAction } from "./hooks/useAction";
import { useActivity } from "./hooks/useActivity";
import { useCanvasState } from "./hooks/useCanvasState";
import { useConfig } from "./hooks/useConfig";
import { useGameStats } from "./hooks/useGameStats";

const queryClient = new QueryClient();

type Point = { x: number; y: number };

function War() {
  const { account, setAccount, loading } = useAccountContext();
  const { data: config } = useConfig();
  const { data: stats } = useGameStats();
  const { data: accountState } = useAccountState();
  const canvas = useCanvasState();
  const activity = useActivity();
  const action = useAction();

  const [tool, setTool] = useState<Tool>("paint");
  const [color, setColor] = useState<number | null>(null);
  const [hover, setHover] = useState<Point | null>(null);

  const team = accountState?.team ?? null;

  // Painting with another team's shade reverts, so the palette follows whichever
  // team the contract assigned.
  useEffect(() => {
    if (team === null) return;
    const allowed = colorsForTeam(team);
    if (color === null || !allowed.includes(color)) {
      setColor(allowed[1] ?? allowed[0]!);
    }
  }, [team, color]);

  const footprint = useMemo(() => {
    if (hover === null) return [];
    return tool === "bomb"
      ? bombFootprint(hover.x, hover.y)
      : [toPixelIndex(hover.x, hover.y)];
  }, [hover, tool]);

  const energy = accountState?.energy ?? 0;
  const maxEnergy = accountState?.maxEnergy ?? config?.energyPerEpoch ?? 30;

  function onPick(point: Point) {
    if (account === null || color === null) return;
    if (energy < TOOL_COST[tool]) return;

    // Optimistic repaint; the server's next delta is authoritative either way.
    if (tool !== "shield") {
      canvas.predict(
        tool === "bomb"
          ? bombFootprint(point.x, point.y)
          : [toPixelIndex(point.x, point.y)],
        color,
      );
    }

    action.mutate({ tool, x: point.x, y: point.y, color });
  }

  const hoverIndex = hover === null ? null : toPixelIndex(hover.x, hover.y);
  const shieldedHover =
    hoverIndex === null ? 0 : (canvas.shields[hoverIndex] ?? 0);
  // A pixel's team is implied by its color, so the holder needs no extra read.
  const hoverColor = hoverIndex === null ? 0 : (canvas.colors[hoverIndex] ?? 0);
  const hoverHolder =
    hoverColor === 0 ? "unclaimed" : teamName(teamOfColor(hoverColor));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-lg tracking-wide">PIXEL WAR</h1>
        <span className="text-xs text-dim">
          a Typewriter app where the batch order is the rulebook
        </span>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span
            className={canvas.connected ? "text-emerald-400" : "text-red-400"}
            title={canvas.connected ? "live" : "reconnecting"}
          >
            ●
          </span>
          <EpochClock
            epoch={canvas.epoch}
            epochStartedAt={canvas.epochStartedAt}
            epochIntervalMs={config?.epochIntervalMs ?? 10_000}
          />
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[auto_20rem]">
        <div className="flex flex-col gap-3">
          <CanvasView
            canvas={canvas}
            onPick={onPick}
            hover={hover}
            onHover={setHover}
            footprint={footprint}
          />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="accept latency"
              value={
                action.lastLatencyMs === null
                  ? "—"
                  : `${action.lastLatencyMs}ms`
              }
              hint="sign → accepted"
            />
            <Stat
              label="mutations/sec"
              value={stats === undefined ? "—" : stats.tps.toFixed(1)}
              hint="10s window"
            />
            <Stat
              label="your pixels"
              value={String(accountState?.painted ?? 0)}
              hint="lifetime"
            />
            <Stat
              label="under cursor"
              value={hover === null ? "—" : hoverHolder}
              hint={
                hover === null
                  ? "hits absorbed"
                  : `${shieldedHover} shield${shieldedHover === 1 ? "" : "s"}`
              }
            />
          </div>
        </div>

        <aside className="flex flex-col gap-4">
          {loading ? (
            <div className="border border-edge bg-panel p-4 text-xs text-dim">
              loading…
            </div>
          ) : account === null ? (
            <SignIn />
          ) : (
            <div className="flex flex-col gap-3 border border-edge bg-panel p-3">
              <div className="flex items-baseline justify-between text-xs">
                <span>
                  {team === null ? "joining…" : teamName(team)}
                  <span className="ml-2 text-dim">
                    {account.accountId.slice(0, 10)}…
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void setAccount(null)}
                  className="text-dim hover:text-ink"
                >
                  sign out
                </button>
              </div>
              <EnergyBar energy={energy} maxEnergy={maxEnergy} />
              {team !== null && color !== null && (
                <Toolbar
                  tool={tool}
                  onTool={setTool}
                  color={color}
                  onColor={setColor}
                  team={team}
                  energy={energy}
                />
              )}
              {action.lastError !== null && (
                <button
                  type="button"
                  onClick={action.clearError}
                  className="text-left text-[11px] text-red-400"
                  title="click to dismiss"
                >
                  {action.lastError}
                </button>
              )}
            </div>
          )}

          <div className="border border-edge bg-panel p-3">
            <Scoreboard teamPixels={canvas.teamPixels} team={team} />
          </div>

          <div className="border border-edge bg-panel p-3">
            <ActivityFeed
              events={activity.events}
              dropped={activity.dropped}
              account={account?.accountId ?? null}
            />
          </div>

          <Rules config={config} />
        </aside>
      </div>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <DomainProvider>
        <AccountProvider>
          <War />
        </AccountProvider>
      </DomainProvider>
    </QueryClientProvider>
  );
}
