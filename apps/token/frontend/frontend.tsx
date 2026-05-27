import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const queryClient = new QueryClient();

const elem = document.getElementById("root");
if (elem === null) {
  throw new Error("missing #root element");
}

const app = (
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
);

if (import.meta.hot) {
  const data = import.meta.hot.data as { root?: ReturnType<typeof createRoot> };
  data.root ??= createRoot(elem);
  data.root.render(app);
} else {
  createRoot(elem).render(app);
}
