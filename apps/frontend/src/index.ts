import { serve } from "bun";
import index from "./index.html";
import { raceSendRawTransactionSync } from "./lib/raceSendRawTransactionSync";

// @ts-expect-error Bun env
const RPC_URL: string = process.env.BUN_PUBLIC_RPC_URL ?? "https://testnet-rpc.monad.xyz";
// @ts-expect-error Bun env
const CHAIN_ID: number = Number(process.env.BUN_PUBLIC_CHAIN_ID ?? "10143");

const server = serve({
  routes: {
    "/api/sendRawTransactionSync": {
      POST: async (req) => {
        try {
          const { serializedTransaction } = (await req.json()) as {
            serializedTransaction: string;
          };
          if (!serializedTransaction) {
            return new Response("Missing serializedTransaction", { status: 400 });
          }
          const receipt = await raceSendRawTransactionSync(
            RPC_URL,
            serializedTransaction,
            CHAIN_ID,
          );
          return Response.json(receipt);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: message }, { status: 502 });
        }
      },
    },
    // Serve index.html for all unmatched routes.
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
