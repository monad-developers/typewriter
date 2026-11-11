import superjson from "superjson";
import { createTypewriter, type MutationStatus } from "typewriter";
import type { Hex } from "viem";
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

const typewriter = await createTypewriter(Token, {
  dev: true,
  database: { url: requireEnv("DATABASE_URL"), maxConnections: 25 },
  sequencing: { order: "fifo" },
});

// Accepted mutations that are not finalized yet, keyed by `accountID:nonce`.
// Clients only ask about mutations they posted, which are accepted before
// `execute` resolves, so a missing key is finalized.
const statuses = new Map<string, MutationStatus>();

typewriter.on("mutation", (mutation) => {
  if (!("executionIndex" in mutation)) return;
  const { accountID, nonce } = mutation.authorization;
  const key = `${accountID}:${nonce}`;
  if (mutation.status === "finalized") {
    statuses.delete(key);
  } else {
    statuses.set(key, mutation.status);
  }
});

const server = Bun.serve({
  routes: {
    "/": index,
    "/api/manifest": () => jsonResponse(typewriter.manifest),
    "/api": {
      POST: async (req) => {
        const body = await req.json();
        await typewriter.execute(
          body as Parameters<typeof typewriter.execute>[0],
        );
        return jsonResponse({ status: "accepted" });
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
      const keys = new URL(req.url).searchParams.get("keys")?.split(",") ?? [];
      return jsonResponse(
        Object.fromEntries(
          keys.map((key) => [key, statuses.get(key) ?? "finalized"]),
        ),
      );
    },
  },
});

console.log(`token app listening on ${server.url}`);
