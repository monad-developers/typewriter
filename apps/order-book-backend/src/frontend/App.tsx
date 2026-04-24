import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Exchange } from "./components/Exchange";
import { Header } from "./components/Header";
import { LiveBlocks } from "./components/LiveBlocks";
import { AccountProvider, useAccountContext } from "./contexts/AccountContext";
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
      </div>
    </main>
  );
}

function ExchangePage() {
  const { account, loading } = useAccountContext();
  if (loading) return null;
  if (!account) return <Auth />;
  return (
    <main className="flex-1 pt-6">
      <Exchange />
      <LiveBlocks />
    </main>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen w-full flex flex-col">
      <Header />
      {children}
    </div>
  );
}

function Routes() {
  const path = useRoute();
  const blockMatch = useMatch("/block/:number");
  const mutationMatch = useMatch("/mutation/:id");
  const accountMatch = useMatch("/account/:id");
  if (blockMatch) return <Shell><BlockPage /></Shell>;
  if (mutationMatch) return <Shell><MutationPage /></Shell>;
  if (accountMatch) return <Shell><AccountPage /></Shell>;
  if (path === "/exchange") return <Shell><ExchangePage /></Shell>;
  return <AboutOrderBook />;
}

export function App() {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider>
        <AccountProvider>
          <Routes />
        </AccountProvider>
      </RouterProvider>
    </QueryClientProvider>
  );
}

export default App;
