import { useQuery } from "@tanstack/react-query";
import type { Team, Tool } from "pixel-war-sdk";
import { request } from "../lib/api";

export type AppConfig = {
  width: number;
  height: number;
  pixelCount: number;
  canvasWords: number;
  palette: string[];
  teams: Team[];
  costs: Record<Tool, number>;
  energyPerEpoch: number;
  maxShieldStack: number;
  bombRadius: number;
  sessionKeyPermissions: number;
  epochIntervalMs: number;
  batchOrder: string[];
  forceInclusionDelay: number;
  contract: string;
  chainId: number;
  explorer: string | null;
};

export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: () => request<AppConfig>("/api/config"),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
