import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { BlockTracker } from "./components/BlockTracker";
import { Exchange } from "./components/Exchange";
import { Header } from "./components/Header";
import { TradeHistory } from "./components/TradeHistory";
import { AccountProvider, useAccountContext } from "./contexts/AccountContext";
import { useSignIn } from "./hooks/useSignIn";
import "./index.css";

function AppInner() {
  const { account, loading } = useAccountContext();
  const signInMutation = useSignIn();
  const [denominationId, setDenominationId] = useState(1); // USD default

  return (
    <div className="min-h-screen w-full flex flex-col pb-14">
      {loading ? null : account ? (
        <>
          <Header
            denominationId={denominationId}
            onDenominationChange={setDenominationId}
          />
          <main className="flex-1 p-4">
            <Exchange denominationId={denominationId} />
            <TradeHistory />
          </main>
        </>
      ) : (
        <main className="flex-1 flex items-center justify-center flex-col gap-3">
          <button
            type="button"
            disabled={signInMutation.isPending}
            onClick={() => signInMutation.mutate()}
            className="px-4 py-2 border rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {signInMutation.isPending ? "Creating account..." : "Create Account"}
          </button>
          <p className="text-sm text-gray-400">
            Create a local account with the private key stored in the browser
            [demo only]
          </p>
        </main>
      )}
      <BlockTracker />
    </div>
  );
}

export function App() {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <AccountProvider>
        <AppInner />
      </AccountProvider>
    </QueryClientProvider>
  );
}

export default App;
