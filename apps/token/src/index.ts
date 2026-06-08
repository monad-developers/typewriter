import { createFFCA, type MutationEvent, type MutationStatus } from "ffca";
import superjson from "superjson";
import {
  type Address,
  type Hex,
  type ParseAbiParameters,
  parseAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import index from "../frontend/index.html";
import {
  type MintParams,
  TOKEN_DOMAIN,
  TOKEN_SIGNATURE_PARAMS,
  type TransferParams,
} from "./app";
import { TOKEN_STORAGE_LAYOUT } from "./storage-layout";

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

const rpcUrl = requireEnv("BUN_PUBLIC_RPC_URL");
const chainId = Number(requireEnv("CHAIN_ID"));
const tokenAddress = requireEnv("TOKEN_ADDRESS") as Address;
const scheduler = privateKeyToAccount(
  requireEnv("SCHEDULER_PRIVATE_KEY") as Hex,
);
const mutations = new Map<number, MutationEvent>();

const ffca = await createFFCA<
  typeof TOKEN_STORAGE_LAYOUT,
  {
    Transfer: {
      params: ParseAbiParameters<"address from, address to, uint256 amount, uint256 nonce, uint256 deadline">;
    };
    Mint: {
      params: ParseAbiParameters<"address to, uint256 amount, uint256 nonce, uint256 deadline">;
    };
  },
  typeof TOKEN_SIGNATURE_PARAMS
>({
  address: tokenAddress,
  signature: { params: TOKEN_SIGNATURE_PARAMS },
  storageLayout: TOKEN_STORAGE_LAYOUT,
  account: scheduler,
  chainId,
  rpcUrl,
  database: { url: requireEnv("DATABASE_URL"), maxConnections: 25 },
  domain: TOKEN_DOMAIN,
  sequencing: { order: "fifo" },
  mutations: {
    Transfer: {
      tag: 0,
      params: parseAbiParameters(
        "address from, address to, uint256 amount, uint256 nonce, uint256 deadline",
      ),
      registerMappingKeys: ({ params }) => {
        const transfer = params as TransferParams;
        return [
          `accounts[${transfer.from}].nonce`,
          `accounts[${transfer.from}].balance`,
          `accounts[${transfer.to}].balance`,
        ];
      },
    },
    Mint: {
      tag: 1,
      params: parseAbiParameters(
        "address to, uint256 amount, uint256 nonce, uint256 deadline",
      ),
      registerMappingKeys: ({ params }) => {
        const mint = params as MintParams;
        return [`accounts[${mint.to}].nonce`, `accounts[${mint.to}].balance`];
      },
    },
  },
});

ffca.on("mutation", (mutation) => {
  mutations.set(mutation.id, mutation);
});

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`;
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? "3000"),
  routes: {
    "/": index,
    "/api/domain": () => jsonResponse(ffca.domain),
    "/api/account/:address": async (req) => {
      const account = ffca.state.accounts[req.params.address as Address];
      return jsonResponse({
        balance: await account.balance,
        nonce: await account.nonce,
      });
    },
    "/api/addresses": () => jsonResponse(Object.keys(ffca.state.accounts)),
    "/api": {
      POST: async (req) => {
        const body = superjson.parse(await req.text()) as {
          name: string;
          params: unknown;
          signature: unknown;
        };
        if (
          typeof body.name !== "string" ||
          body.params === undefined ||
          body.signature === undefined
        ) {
          return new Response("Bad Request", { status: 400 });
        }
        const mutation = await ffca.execute({
          name: body.name,
          params: body.params,
          signature: body.signature,
        } as never);
        return jsonResponse(mutation);
      },
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
    "/*": index,
  },
});

console.log(`token app listening on ${server.url}`);
