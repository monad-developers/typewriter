import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Header, type StateView } from "./components/Header";
import { Transfer } from "./components/Transfer";
import { TxHistory } from "./components/TxHistory";
import { AccountProvider, useAccountContext } from "./contexts/AccountContext";
import { useAvailableAccounts } from "./hooks/useAvailableAccounts";
import { useSignIn } from "./hooks/useSignIn";
import "./index.css";

const queryClient = new QueryClient();

function AppInner() {
  const { account } = useAccountContext();
  const signInMutation = useSignIn();
  const { data: availableAccounts, isLoading: isLoadingAccounts } =
    useAvailableAccounts();
  const [stateView, setStateView] = useState<StateView>("proposed");

  const signInDisabled =
    isLoadingAccounts ||
    availableAccounts === undefined ||
    availableAccounts.length === 0 ||
    signInMutation.isPending;

  return (
    <div className="min-h-screen w-full flex flex-col">
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
            disabled={signInDisabled}
            onClick={() =>
              availableAccounts && signInMutation.mutate(availableAccounts)
            }
            className="px-4 py-2 border rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {signInMutation.isPending
              ? "Minting..."
              : isLoadingAccounts
                ? "Loading..."
                : "Sign In"}
          </button>
        </main>
      )}
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AccountProvider>
        <AppInner />
      </AccountProvider>
    </QueryClientProvider>
  );
}

export default App;
