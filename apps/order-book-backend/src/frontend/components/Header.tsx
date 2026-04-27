import { TokenAmount, USD } from "order-book-sdk";
import { useAccountContext } from "../contexts/AccountContext";
import { useAccount } from "../hooks/useAccount";
import { useBalances } from "../hooks/useBalances";
import { Link } from "../lib/router";

export function Header({ compact = false }: { compact?: boolean }) {
  const { account, setAccount } = useAccountContext();
  const { data } = useBalances(account?.accountId);
  const accountQuery = useAccount(account?.accountId);

  const rawBalance = data?.balances[USD] ?? "0";
  const balance = TokenAmount.fromRaw(BigInt(rawBalance), USD).human;
  const serial = accountQuery.data?.serial;

  return (
    <header className="w-full px-4 sm:px-6 py-2 sm:py-0 sm:h-12 flex flex-wrap items-center gap-x-4 gap-y-2 sm:gap-6 text-sm">
      <Link to="/exchange" className="text-blue-500 hover:underline">
        /exchange
      </Link>
      <Link to="/about" className="text-blue-500 hover:underline">
        /about
      </Link>
      {compact ? null : (
        <>
          <span className="flex-1" />
          {account ? (
            <div className="flex items-center gap-3 sm:gap-6 flex-wrap">
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
            </div>
          ) : (
            <Link to="/exchange" className="text-blue-500 hover:underline">
              /exchange →
            </Link>
          )}
        </>
      )}
    </header>
  );
}
