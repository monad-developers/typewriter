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
    <header className="w-full border-b border-border h-16 px-8 flex items-center gap-6 bg-background/80 backdrop-blur-sm sticky top-0 z-10">
      <Link
        to="/"
        className="flex items-center gap-2 font-semibold tracking-tight transition-colors hover:opacity-70"
      >
        <span className="w-2 h-2 rounded-full bg-foreground" />
        Order Book
      </Link>
      <span className="flex-1" />
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Balance</span>
        <span className="font-mono tabular-nums font-medium">
          ${balance.toFixed(2)}
        </span>
      </div>
      <Button
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
      {serial != null ? (
        <Link
          to={`/account/${serial}`}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Account #{serial}
        </Link>
      ) : null}
      <Button variant="ghost" size="sm" onClick={() => void setAccount(null)}>
        Sign out
      </Button>
    </header>
  );
}
