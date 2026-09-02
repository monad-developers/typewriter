import superjson from "superjson";
import {
  createTypewriter,
  type MutationEvent,
  type MutationStatus,
} from "typewriter";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import Token from "../contracts/src/Token.sol";
import index from "../frontend/index.html";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} env var is required`);
  }
  return value;
}

function jsonResponse(data: unknown): Response {
  return new Response(superjson.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

const scheduler = privateKeyToAccount(requireEnv("PRIVATE_KEY") as Hex);

const typewriter = await createTypewriter(Token, {
  address: requireEnv("TOKEN_ADDRESS") as Address,
  account: scheduler,
  chainId: Number(requireEnv("CHAIN_ID")),
  rpcUrl: requireEnv("RPC_URL"),
  database: { url: requireEnv("DATABASE_URL"), maxConnections: 25 },
  sequencing: { order: "fifo" },
});

const mutations = new Map<number, MutationEvent>();

typewriter.on("mutation", (mutation) => {
  mutations.set(mutation.id, mutation);
});

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`;
}

const server = Bun.serve({
  routes: {
    "/": index,
    "/api": {
      POST: async (req) => {
        const body = superjson.parse(await req.text());
        const mutation = await typewriter.execute(
          body as Parameters<typeof typewriter.execute>[0],
        );
        return jsonResponse(mutation);
      },
    },
    "/api/accountIds": () =>
      jsonResponse(Object.keys(typewriter.state.balances)),
    "/api/account/:accountID": async (req) => {
      const accountID = req.params.accountID as Hex;
      return jsonResponse({
        balance: await typewriter.state.balances[accountID],
      });
    },
    "/api/mutation/:id/status": {
      GET: (req) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) {
          return new Response("Bad Request", { status: 400 });
        }

        const stream = new ReadableStream({
          async start(controller) {
            let last: MutationStatus | undefined;
            while (true) {
              const mutation = mutations.get(id);
              if (mutation !== undefined && mutation.status !== last) {
                last = mutation.status;
                controller.enqueue(sse({ status: mutation.status }));
              }
              if (last === "finalized" || last === "rejected") break;
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      },
    },
  },
});

console.log(`token app listening on ${server.url}`);
