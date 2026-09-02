import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { USD } from "order-book-sdk";
import { useState } from "react";
import { Deposit } from "./components/Deposit";
import { Header } from "./components/Header";
import { LiveBlocks } from "./components/LiveBlocks";
import { OrderBook } from "./components/OrderBook";
import { AccountProvider, useAccountContext } from "./contexts/AccountContext";
import { ManifestProvider } from "./contexts/ManifestContext";
import { useBalances } from "./hooks/useBalances";
import { useDemoSignUp } from "./hooks/useDemoSignUp";
import { useSignUp } from "./hooks/useSignUp";
import "./index.css";
import { RouterProvider, useMatch, useRoute } from "./lib/router";
import { AboutOrderBook } from "./pages/AboutOrderBook";
import { AccountPage } from "./pages/AccountPage";
import { BlockPage } from "./pages/BlockPage";
import { MutationPage } from "./pages/MutationPage";

function Auth() {
  const signUp = useSignUp();
  const demoSignUp = useDemoSignUp();
  const isPending = signUp.isPending || demoSignUp.isPending;
  const error = signUp.error ?? demoSignUp.error;

  return (
    <main className="flex-1 flex items-center justify-center">
      <div className="flex flex-col gap-3 items-center">
        <button
          type="button"
          disabled={isPending}
          onClick={() => signUp.mutate()}
          className="px-6 py-2 border border-black text-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed w-56"
        >
          {signUp.isPending ? "Creating..." : "Create passkey"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => demoSignUp.mutate()}
          className="text-sm text-zinc-500 hover:text-black hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {demoSignUp.isPending ? "Creating..." : "or try the demo"}
        </button>
        {error ? (
          <div className="text-sm text-red-600 max-w-sm text-center">
            {error instanceof Error ? error.message : "Create account failed"}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function OrderBookRoute() {
  const { account, loading } = useAccountContext();
  const balances = useBalances(account?.accountId);

  if (loading) return <Shell compact />;
  if (!account)
    return (
      <Shell compact>
        <Auth />
      </Shell>
    );
  if (!balances.data) return <Shell compact />;
  const usdRaw = BigInt(balances.data.balances[USD] ?? "0");
  if (usdRaw === 0n) {
    return (
      <Shell compact>
        <main className="flex-1 flex items-center justify-center pt-6">
          <Deposit />
        </main>
      </Shell>
    );
  }
  return (
    <Shell>
      <main className="flex-1 pt-6">
        <OrderBook />
        <LiveBlocks />
      </main>
    </Shell>
  );
}

function Shell({
  children,
  compact = false,
}: {
  children?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className="min-h-screen w-full flex flex-col">
      <Header compact={compact} />
      {children}
    </div>
  );
}

function Routes() {
  const path = useRoute();
  const blockMatch = useMatch("/block/:number");
  const mutationMatch = useMatch("/mutation/:id");
  const accountMatch = useMatch("/account/:id");
  if (blockMatch)
    return (
      <Shell>
        <BlockPage />
      </Shell>
    );
  if (mutationMatch)
    return (
      <Shell>
        <MutationPage />
      </Shell>
    );
  if (accountMatch)
    return (
      <Shell>
        <AccountPage />
      </Shell>
    );
  if (path === "/order-book") return <OrderBookRoute />;
  if (path === "/about") return <AboutOrderBook />;
  return <AboutOrderBook />;
}

export function App() {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider>
        <ManifestProvider>
          <AccountProvider>
            <Routes />
          </AccountProvider>
        </ManifestProvider>
      </RouterProvider>
    </QueryClientProvider>
  );
}

export default App;
