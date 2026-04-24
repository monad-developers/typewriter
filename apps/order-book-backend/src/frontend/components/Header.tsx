import { TokenAmount, USD } from "order-book-sdk";
import { useAccountContext } from "../contexts/AccountContext";
import { useAccount } from "../hooks/useAccount";
import { useBalances } from "../hooks/useBalances";
import { useDepositMutation } from "../hooks/useDepositMutation";
import { Link } from "../lib/router";
import { Button } from "./ui/button";

export function Header() {
  const { account, setAccount } = useAccountContext();
  const { data } = useBalances(account?.accountId);
  const accountQuery = useAccount(account?.accountId);
  const depositMutation = useDepositMutation();

  const rawBalance = data?.balances[USD] ?? "0";
  const balance = TokenAmount.fromRaw(BigInt(rawBalance), USD).human;
  const serial = accountQuery.data?.serial;

  async function handleDeposit() {
    await depositMutation.mutateAsync({
      asset: USD,
      amount: TokenAmount.from(1000, USD).raw,
    });
  }

  return (
    <header className="w-full border-b border-border px-6 h-12 flex items-center gap-4">
      <Link
        to="/"
        className="text-[11px] uppercase tracking-[0.18em] font-semibold hover:text-sky-700 transition-colors"
      >
        order book
      </Link>
      <span className="h-4 w-px bg-border" />
      <div className="flex items-baseline gap-1.5 text-sm">
        <span className="text-muted-foreground text-xs">balance</span>
        <span className="tabular-nums">${balance.toFixed(2)}</span>
      </div>
      <Button
        size="sm"
        onClick={() => void handleDeposit()}
        disabled={!account || depositMutation.isPending}
      >
        {depositMutation.isPending ? "depositing…" : "deposit"}
      </Button>
      {depositMutation.error ? (
        <span className="text-sm text-red-600">
          {depositMutation.error instanceof Error
            ? depositMutation.error.message
            : "deposit failed"}
        </span>
      ) : null}
      <span className="flex-1" />
      {serial != null ? (
        <Link
          to={`/account/${serial}`}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          account #{serial}
        </Link>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => void setAccount(null)}>
        sign out
      </Button>
    </header>
  );
}
