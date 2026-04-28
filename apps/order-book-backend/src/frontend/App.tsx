// ABOUT-ONLY FALLBACK BUILD
// All exchange/account/block/mutation routes and their data hooks are stripped
// out. Every URL renders the About page so the page is reachable even with no
// backend services running. Restore by checking out `ob` (or main).

import "./index.css";
import { RouterProvider } from "./lib/router";
import { AboutOrderBook } from "./pages/AboutOrderBook";

export function App() {
  return (
    <RouterProvider>
      <AboutOrderBook />
    </RouterProvider>
  );
}

export default App;
