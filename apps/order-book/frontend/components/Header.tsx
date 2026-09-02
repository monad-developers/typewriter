import { TokenAmount, USD } from "order-book-sdk";
import { useAccountContext } from "../contexts/AccountContext";
import { useAccount } from "../hooks/useAccount";
import { useBalances } from "../hooks/useBalances";
import { usePing } from "../hooks/usePing";
import { Link } from "../lib/router";

export function Header({ compact = false }: { compact?: boolean }) {
  return (
    <header className="w-full px-6 h-12 flex items-center gap-6 text-sm">
      <Link to="/order-book" className="text-blue-500 hover:underline">
        /order-book
      </Link>
      <Link to="/about" className="text-blue-500 hover:underline">
        /about
      </Link>
      <Ping />
      {compact ? null : <HeaderAccountControls />}
    </header>
  );
}

function Ping() {
  const ping = usePing();
  const latency = ping.data;
  const value =
    ping.isError || latency === undefined
      ? ping.isError
        ? "offline"
        : "..."
      : latency < 1
        ? "<1 ms"
        : `${Math.round(latency)} ms`;

  return (
    <span
      className={ping.isError ? "tabular-nums text-red-600" : "tabular-nums"}
      title="Browser-to-server round-trip time, including response download and parsing"
    >
      ping: {value}
    </span>
  );
}

function HeaderAccountControls() {
  const { account, setAccount } = useAccountContext();
  const { data } = useBalances(account?.accountId);
  const accountQuery = useAccount(account?.accountId);

  const rawBalance = data?.balances[USD] ?? "0";
  const balance = TokenAmount.fromRaw(BigInt(rawBalance), USD).human;
  const accountID = accountQuery.data?.address;

  return (
    <>
      <span className="flex-1" />
      {account ? (
        <>
          <span>balance: ${balance.toFixed(2)}</span>
          {accountID != null ? (
            <Link
              to={`/account/${accountID}`}
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
        <Link to="/order-book" className="text-blue-500 hover:underline">
          /order-book →
        </Link>
      )}
    </>
  );
}
