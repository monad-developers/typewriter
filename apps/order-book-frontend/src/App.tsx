import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { BlockTracker } from "./components/BlockTracker";
import { Exchange } from "./components/Exchange";
import { Header } from "./components/Header";
import { TradeHistory } from "./components/TradeHistory";
import { AccountProvider } from "./contexts/AccountContext";
import "./index.css";

function AppInner() {
  const [denominationId, setDenominationId] = useState(1);

  return (
    <div className="min-h-screen w-full flex flex-col pb-14">
      <Header
        denominationId={denominationId}
        onDenominationChange={setDenominationId}
      />
      <main className="flex-1 p-4">
        <Exchange denominationId={denominationId} />
        <TradeHistory />
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
