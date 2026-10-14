import { useQuery } from "@tanstack/react-query";
import type { TypewriterManifest } from "typewriter";
import { request } from "../lib/api";

export function useManifest() {
  return useQuery({
    queryKey: ["manifest"],
    queryFn: () => request<TypewriterManifest>("/api/manifest"),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
