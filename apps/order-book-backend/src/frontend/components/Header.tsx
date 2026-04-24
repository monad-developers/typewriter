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
    <header className="w-full border-b border-border h-14 px-6 flex items-center gap-5 bg-background">
      <Link
        to="/"
        className="flex items-center gap-2 text-sm font-semibold tracking-tight hover:text-indigo-600 transition-colors"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" />
        Order Book
      </Link>
      <span className="h-5 w-px bg-border" />
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-[0.16em] font-bold text-muted-foreground">
          balance
        </span>
        <span className="font-mono tabular-nums text-sm font-medium">
          ${balance.toFixed(2)}
        </span>
      </div>
      <Button
        size="sm"
        onClick={() => void handleDeposit()}
        disabled={!account || depositMutation.isPending}
      >
        {depositMutation.isPending ? "Depositing…" : "Deposit"}
      </Button>
      {depositMutation.error ? (
        <span className="text-sm text-rose-600">
          {depositMutation.error instanceof Error
            ? depositMutation.error.message
            : "Deposit failed"}
        </span>
      ) : null}
      <span className="flex-1" />
      {serial != null ? (
        <Link
          to={`/account/${serial}`}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors font-mono tabular-nums"
        >
          acct #{serial}
        </Link>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => void setAccount(null)}>
        Sign out
      </Button>
    </header>
  );
}
