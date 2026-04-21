import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { BlockTracker } from "./components/BlockTracker";
import { Exchange } from "./components/Exchange";
import { Header } from "./components/Header";
import { AccountProvider, useAccountContext } from "./contexts/AccountContext";
import { useDemoSignUp } from "./hooks/useDemoSignUp";
import { useSignUp } from "./hooks/useSignUp";
import "./index.css";

function Auth() {
  const signUp = useSignUp();
  const demoSignUp = useDemoSignUp();
  const isPending = signUp.isPending || demoSignUp.isPending;

  return (
    <div className="min-h-screen w-full flex flex-col">
      <main className="flex-1 flex items-center justify-center flex-col gap-6">
        <div className="flex flex-col gap-3 items-center">
          <button
            type="button"
            disabled={isPending}
            onClick={() => signUp.mutate()}
            className="px-6 py-2 border rounded hover:bg-gray-50 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed w-56"
          >
            {signUp.isPending ? "Creating..." : "Create passkey"}
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={() => demoSignUp.mutate()}
            className="text-sm text-gray-400 hover:text-gray-600 underline cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {demoSignUp.isPending ? "Creating..." : "or try the demo"}
          </button>
        </div>
      </main>
    </div>
  );
}

function AppInner() {
  const { account, loading } = useAccountContext();

  if (loading) return null;
  if (!account) return <Auth />;

  return (
    <div className="min-h-screen w-full flex flex-col pb-14">
      <Header />
      <main className="flex-1 p-4">
        <Exchange />
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
