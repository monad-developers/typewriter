import { TokenAmount, USD } from "order-book-sdk";
import { useAccountContext } from "../contexts/AccountContext";
import { useAccount } from "../hooks/useAccount";
import { useBalances } from "../hooks/useBalances";
import { useDepositMutation } from "../hooks/useDepositMutation";
import { Link } from "../lib/router";

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
    <header className="w-full border-b border-black px-6 h-12 flex items-center gap-6 text-sm">
      <Link to="/" className="font-semibold hover:underline">
        order-book
      </Link>
      <span className="flex-1" />
      {account ? (
        <>
          <span>balance: ${balance.toFixed(2)}</span>
          <button
            type="button"
            onClick={() => void handleDeposit()}
            disabled={depositMutation.isPending}
            className="border border-black px-3 py-1 disabled:opacity-50 cursor-pointer hover:bg-zinc-50"
          >
            {depositMutation.isPending ? "depositing..." : "deposit"}
          </button>
          {serial != null ? (
            <Link
              to={`/account/${serial}`}
              className="text-blue-500 hover:underline"
            >
              account {serial}
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => void setAccount(null)}
            className="border border-black px-3 py-1 cursor-pointer hover:bg-zinc-50"
          >
            sign out
          </button>
        </>
      ) : (
        <Link to="/exchange" className="text-blue-500 hover:underline">
          /exchange →
        </Link>
      )}
    </header>
  );
}
