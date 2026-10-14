import { useQuery } from "@tanstack/react-query";
import type { TokenManifest } from "../App";
import { request } from "../lib/api";

export function useManifest() {
  return useQuery({
    queryKey: ["manifest"],
    queryFn: () => request<TokenManifest>("/api/manifest"),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
