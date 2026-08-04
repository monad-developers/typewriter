import { useQuery } from "@tanstack/react-query";
import { request } from "../lib/api";

export type GameStats = {
  epoch: number;
  epochStartedAt: number;
  epochIntervalMs: number;
  teamPixels: number[];
  pixelCount: number;
  tps: number;
};

export function useGameStats() {
  return useQuery({
    queryKey: ["gameStats"],
    queryFn: () => request<GameStats>("/api/state"),
    refetchInterval: 2000,
  });
}
