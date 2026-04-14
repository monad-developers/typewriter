"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "~/lib/utils";
import { accountOptions, persistAccount } from "~/lib/account";
import { useBalances } from "~/hooks/use-balances";
import { useDepositMutation } from "~/hooks/use-deposit";
import { USD_ADDRESS } from "~/lib/constants";

const NAV_LINKS = [
  { href: "/trade", label: "Trade" },
  { href: "/info", label: "Info" },
];

const DEPOSIT_AMOUNT = 50000n;

export function Header() {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { data: account, isLoading } = useQuery(accountOptions);
  const { data } = useBalances(account?.accountId);
  const depositMutation = useDepositMutation();

  const balance = data?.balances[USD_ADDRESS] ?? "0";

  async function handleDeposit() {
    await depositMutation.mutateAsync({
      asset: USD_ADDRESS,
      amount: DEPOSIT_AMOUNT,
    });
  }

  return (
    <header className="h-12 bg-card border-b border-border flex items-center px-4 md:px-6 shrink-0">
      <Link href="/trade" className="text-sm font-bold tracking-wide mr-8">
        Demo Exchange
      </Link>
      <nav className="flex items-center gap-1">
        {NAV_LINKS.map((link) => {
          const isActive = pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "px-3 py-1.5 text-sm rounded-md transition-colors",
                isActive
                  ? "text-foreground bg-muted"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>

      <span className="flex-1" />

      {!isLoading && account && (
        <div className="flex items-center gap-4">
          <span className="text-xs font-mono text-muted-foreground">
            ${balance}
          </span>

          {depositMutation.error && (
            <span className="text-xs text-destructive">
              {depositMutation.error instanceof Error
                ? depositMutation.error.message
                : "Deposit failed"}
            </span>
          )}

          <button
            type="button"
            onClick={() => void handleDeposit()}
            disabled={depositMutation.isPending}
            className="border border-border px-3 py-1 text-xs font-mono rounded-md text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
          >
            {depositMutation.isPending ? "depositing..." : "deposit"}
          </button>

          <button
            type="button"
            onClick={() => void persistAccount(queryClient, null)}
            className="border border-border px-3 py-1 text-xs font-mono rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            sign out
          </button>
        </div>
      )}
    </header>
  );
}
