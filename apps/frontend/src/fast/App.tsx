import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TOKEN_FAST_ADDRESS } from "../constants";
import { Header } from "./components/Header";
import { Transfer } from "./components/Transfer";
import { TxHistory } from "./components/TxHistory";
import { AccountProvider, useAccountContext } from "./contexts/AccountContext";
import { useSignIn } from "./hooks/useSignIn";
import { AboutFast } from "./pages/AboutFast";
import "../index.css";

function AppInner() {
  const { account, loading } = useAccountContext();
  const signInMutation = useSignIn();

  if (window.location.pathname === "/fast/about") {
    return <AboutFast />;
  }

  return (
    <div className="min-h-screen w-full flex flex-col">
      <div className="w-full border-b p-4 flex flex-col gap-2">
        <p className="text-lg">
          Transfer tokens on Monad testnet while tracing every JSON-RPC request
          and measuring latency. See the{" "}
          <span className="font-bold">
            practical throughput and latency bottlenecks
          </span>{" "}
          that the transaction lifecycle imposes on every app.
        </p>
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm text-blue-500 hover:underline">
            ← Go back
          </a>
          <span className="text-sm text-muted-foreground">|</span>
          <a
            href="/fast/about"
            className="text-sm text-blue-500 hover:underline"
          >
            About
          </a>
          <span className="text-sm text-muted-foreground">|</span>
          <a
            href={`https://testnet.monadexplorer.com/address/${TOKEN_FAST_ADDRESS}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-500 hover:underline"
          >
            Token contract ↗
          </a>
        </div>
      </div>
      {loading ? null : account ? (
        <>
          <Header />
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

const queryClient = new QueryClient();

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
