"use client";

import { useQuery } from "@tanstack/react-query";
import { accountOptions } from "~/lib/account";
import { AuthScreen } from "./auth-screen";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { data: account, isLoading } = useQuery(accountOptions);

  if (isLoading) return null;
  if (!account) return <AuthScreen />;

  return <>{children}</>;
}
