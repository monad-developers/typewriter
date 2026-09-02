import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type { TypewriterManifest } from "typewriter";
import { request } from "../lib/api";

type ManifestContextValue = {
  manifest: TypewriterManifest | null;
  storagePrefix: string | null;
  loading: boolean;
};

const ManifestContext = createContext<ManifestContextValue | null>(null);

export function ManifestProvider({ children }: { children: React.ReactNode }) {
  const { data: manifest = null, isLoading: loading } = useQuery({
    queryKey: ["manifest"],
    queryFn: () => request<TypewriterManifest>("/api/manifest"),
    staleTime: Number.POSITIVE_INFINITY,
  });

  return (
    <ManifestContext.Provider
      value={{
        manifest,
        storagePrefix: manifest === null ? null : manifest.address,
        loading,
      }}
    >
      {children}
    </ManifestContext.Provider>
  );
}

export function useManifestContext() {
  const ctx = useContext(ManifestContext);
  if (!ctx) {
    throw new Error("useManifestContext must be used within ManifestProvider");
  }
  return ctx;
}
