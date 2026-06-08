import { TokenAmount, USD } from "order-book-sdk";
import { useAccountContext } from "../contexts/AccountContext";
import { useAccount } from "../hooks/useAccount";
import { useBalances } from "../hooks/useBalances";
import { Link } from "../lib/router";

export function Header({ compact = false }: { compact?: boolean }) {
  return (
    <header className="w-full px-6 h-12 flex items-center gap-6 text-sm">
      <Link to="/exchange" className="text-blue-500 hover:underline">
        /exchange
      </Link>
      <Link to="/about" className="text-blue-500 hover:underline">
        /about
      </Link>
      {compact ? null : <HeaderAccountControls />}
    </header>
  );
}

function HeaderAccountControls() {
  const { account, setAccount } = useAccountContext();
  const { data } = useBalances(account?.accountId);
  const accountQuery = useAccount(account?.accountId);

  const rawBalance = data?.balances[USD] ?? "0";
  const balance = TokenAmount.fromRaw(BigInt(rawBalance), USD).human;
  const serial = accountQuery.data?.serial;

  return (
    <>
      <span className="flex-1" />
      {account ? (
        <>
          <span>balance: ${balance.toFixed(2)}</span>
          {serial != null ? (
            <Link
              to={`/account/${serial}`}
              className="text-blue-500 hover:underline"
            >
              view account
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
    </>
  );
}
