import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Exchange } from "./components/Exchange";
import { Header } from "./components/Header";
import { LiveBlocks } from "./components/LiveBlocks";
import { Button } from "./components/ui/button";
import { PageShell } from "./components/ui/page";
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
    <PageShell>
      <main className="flex-1 flex items-center justify-center px-6">
        <div className="w-full max-w-sm flex flex-col items-stretch gap-6">
          <div className="text-center">
            <div className="flex items-center justify-center gap-2 mb-8">
              <span className="w-2 h-2 rounded-full bg-foreground" />
              <span className="text-sm font-medium tracking-tight">
                Order Book
              </span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight mb-2">
              Sign in to trade
            </h1>
            <p className="text-sm text-muted-foreground">
              Create a passkey. No seed phrase, no wallet.
            </p>
          </div>
          <Button
            variant="solid"
            size="lg"
            disabled={isPending}
            onClick={() => signUp.mutate()}
          >
            {signUp.isPending ? "Creating…" : "Create passkey"}
          </Button>
          <button
            type="button"
            disabled={isPending}
            onClick={() => demoSignUp.mutate()}
            className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-4 decoration-1 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {demoSignUp.isPending ? "Creating…" : "or try the demo"}
          </button>
        </div>
      </main>
    </PageShell>
  );
}

function TradingApp() {
  const { account, loading } = useAccountContext();

  if (loading) return null;
  if (!account) return <Auth />;

  return (
    <PageShell>
      <Header />
      <main className="flex-1 px-8 py-8">
        <Exchange />
      </main>
      <LiveBlocks />
    </PageShell>
  );
}

function Routes() {
  const path = useRoute();
  const blockMatch = useMatch("/block/:number");
  const mutationMatch = useMatch("/mutation/:id");
  const accountMatch = useMatch("/account/:id");
  if (blockMatch) return <BlockPage />;
  if (mutationMatch) return <MutationPage />;
  if (accountMatch) return <AccountPage />;
  if (path === "/exchange") return <TradingApp />;
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
