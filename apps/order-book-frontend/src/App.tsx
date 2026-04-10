import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { BlockTracker } from "./components/BlockTracker";
import { Exchange } from "./components/Exchange";
import { Header } from "./components/Header";
import { AccountProvider, useAccountContext } from "./contexts/AccountContext";
import { useSignIn } from "./hooks/useSignIn";
import { useSignUp } from "./hooks/useSignUp";
import "./index.css";

function Auth() {
  const signIn = useSignIn();
  const signUp = useSignUp();
  const isPending = signIn.isPending || signUp.isPending;

  return (
    <div className="min-h-screen w-full flex flex-col">
      <main className="flex-1 flex items-center justify-center flex-col gap-6">
        <div className="flex flex-col gap-3 items-center">
          <button
            type="button"
            disabled={isPending}
            onClick={() => signIn.mutate()}
            className="px-6 py-2 border rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed w-56"
          >
            {signIn.isPending ? "Signing in..." : "Sign in with passkey"}
          </button>
          <div className="flex items-center gap-3 text-sm text-gray-400">
            <span className="h-px w-12 bg-gray-200" />
            or
            <span className="h-px w-12 bg-gray-200" />
          </div>
          <button
            type="button"
            disabled={isPending}
            onClick={() => signUp.mutate()}
            className="px-6 py-2 border rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed w-56"
          >
            {signUp.isPending ? "Creating account..." : "Create account"}
          </button>
        </div>
      </main>
    </div>
  );
}

function AppInner() {
  const { account, loading } = useAccountContext();
  const [denominationId, setDenominationId] = useState(1);

  if (loading) return null;
  if (!account) return <Auth />;

  return (
    <div className="min-h-screen w-full flex flex-col pb-14">
      <Header
        denominationId={denominationId}
        onDenominationChange={setDenominationId}
      />
      <main className="flex-1 p-4">
        <Exchange denominationId={denominationId} />
      </main>
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
