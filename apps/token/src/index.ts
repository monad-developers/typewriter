import superjson from "superjson";
import { createTypewriter, type MutationStatus } from "typewriter";
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

const { CHAIN_ID, PRIVATE_KEY, RPC_URL, TOKEN_ADDRESS } = process.env;

const typewriter = await createTypewriter(Token, {
  // Without RPC_URL, development runs on a local Anvil that typewriter starts
  // and deploys the token to.
  dev: process.env.NODE_ENV !== "production" && RPC_URL === undefined,
  address: TOKEN_ADDRESS as Address | undefined,
  account: PRIVATE_KEY ? privateKeyToAccount(PRIVATE_KEY as Hex) : undefined,
  chainId: CHAIN_ID ? Number(CHAIN_ID) : undefined,
  rpcUrl: RPC_URL,
  database: { url: requireEnv("DATABASE_URL"), maxConnections: 25 },
  sequencing: { order: "fifo" },
});

// Accepted mutations that are not finalized yet. Clients only ask about
// mutations they posted, which are accepted before `execute` resolves, so a
// missing execution index is finalized.
const statuses = new Map<bigint, MutationStatus>();

typewriter.on("mutation", (mutation) => {
  if (!("executionIndex" in mutation)) return;
  if (mutation.status === "finalized") {
    statuses.delete(mutation.executionIndex);
  } else {
    statuses.set(mutation.executionIndex, mutation.status);
  }
});

const server = Bun.serve({
  routes: {
    "/": index,
    "/api/manifest": () => jsonResponse(typewriter.manifest),
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
    "/api/account/:accountID": (req) => {
      const accountID = req.params.accountID as Hex;
      return jsonResponse({
        balance: typewriter.state.balances[accountID],
      });
    },
    "/api/mutations/status": (req) => {
      const executionIndexes =
        new URL(req.url).searchParams.get("executionIndexes")?.split(",") ?? [];
      if (!executionIndexes.every((index) => /^\d+$/.test(index))) {
        return new Response("Bad Request", { status: 400 });
      }
      return jsonResponse(
        Object.fromEntries(
          executionIndexes.map((index) => [
            index,
            statuses.get(BigInt(index)) ?? "finalized",
          ]),
        ),
      );
    },
  },
});

console.log(`token app listening on ${server.url}`);
