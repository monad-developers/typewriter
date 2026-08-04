import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type { Hex } from "viem";
import { request } from "../lib/api";
import { type AppDomain, domainHash } from "../lib/domain";

type DomainContextValue = {
  domain: AppDomain | null;
  storagePrefix: Hex | null;
  loading: boolean;
};

const DomainContext = createContext<DomainContextValue | null>(null);

export function DomainProvider({ children }: { children: React.ReactNode }) {
  const { data: domain = null, isLoading: loading } = useQuery({
    queryKey: ["domain"],
    queryFn: () => request<AppDomain>("/api/domain"),
    staleTime: Number.POSITIVE_INFINITY,
  });

  return (
    <DomainContext.Provider
      value={{
        domain,
        storagePrefix: domain === null ? null : domainHash(domain),
        loading,
      }}
    >
      {children}
    </DomainContext.Provider>
  );
}

export function useDomainContext() {
  const ctx = useContext(DomainContext);
  if (!ctx) {
    throw new Error("useDomainContext must be used within DomainProvider");
  }
  return ctx;
}
