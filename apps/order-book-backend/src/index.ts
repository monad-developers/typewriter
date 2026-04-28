// ABOUT-ONLY FALLBACK BUILD
// All runtime, database, RPC, and API logic is disabled. This server only
// boots Bun and serves the SPA so the About page is reachable. Restore by
// pointing Railway back at the `ob` (or main) branch.

import { serve } from "bun";
import index from "./frontend/index.html";

serve({
  idleTimeout: 0,
  routes: {
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log("about-only server started");
