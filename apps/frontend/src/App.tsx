import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Header, type StateView } from "./components/Header";
import { Transfer } from "./components/Transfer";
import { TxHistory } from "./components/TxHistory";
import { AccountProvider, useAccountContext } from "./contexts/AccountContext";
import { useSignIn } from "./hooks/useSignIn";
import "./index.css";

function AppInner() {
  const { account } = useAccountContext();
  const signInMutation = useSignIn();
  const [stateView, setStateView] = useState<StateView>("proposed");

  return (
    <div className="min-h-screen w-full flex flex-col">
      <div className="w-full border-b p-4">
        <p className="text-lg">
          Send token transfers and see every step of the transaction lifecycle —
          from the RPC calls your wallet makes to how your transaction gets
          confirmed. See the{" "}
          <span className="font-bold">
            practical throughput and latency bottlenecks
          </span>{" "}
          for apps.
        </p>
      </div>
      {account ? (
        <>
          <Header stateView={stateView} onStateViewChange={setStateView} />
          <Transfer />
          <TxHistory />
        </>
      ) : (
        <main className="flex-1 flex items-center justify-center flex-col gap-3">
          <button
            type="button"
            disabled={signInMutation.isPending}
            onClick={() => signInMutation.mutate()}
            className="px-4 py-2 border rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {signInMutation.isPending ? "Signing in..." : "Sign In"}
          </button>
          <p className="text-sm text-gray-400">
            Create a local account with the private key stored in the browser
            [demo only]
          </p>
        </main>
      )}
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
