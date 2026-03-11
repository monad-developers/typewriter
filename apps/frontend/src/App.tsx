import { useState } from "react";
import { Header, type StateView } from "./components/Header";
import { Transfer } from "./components/Transfer";
import { TxHistory } from "./components/TxHistory";
import "./index.css";

export function App() {
  const [authed, setAuthed] = useState(false);
  const [stateView, setStateView] = useState<StateView>("proposed");

  return (
    <div className="min-h-screen w-full flex flex-col">
      <Header
        authed={authed}
        stateView={stateView}
        onStateViewChange={setStateView}
      />
      {authed ? (
        <>
          <Transfer />
          <TxHistory />
        </>
      ) : (
        <main className="flex-1 flex items-center justify-center">
          <button
            type="button"
            onClick={() => setAuthed(true)}
            className="px-4 py-2 border rounded hover:bg-gray-50"
          >
            Sign In
          </button>
        </main>
      )}
    </div>
  );
}

export default App;
