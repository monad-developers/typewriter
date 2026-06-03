import { createFFCA, type MutationEvent, type MutationStatus } from "ffca";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import index from "../frontend/index.html";
import {
  signMint,
  TOKEN_DOMAIN,
  TOKEN_SIGNATURE_PARAMS,
  type TokenSignature,
  tokenMutations,
} from "./app";
import { TOKEN_STORAGE_LAYOUT } from "./storage-layout";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} env var is required`);
  }
  return value;
}

const rpcUrl = requireEnv("BUN_PUBLIC_RPC_URL");
const chainId = Number(process.env.CHAIN_ID ?? "31337");
const tokenAddress = requireEnv("TOKEN_ADDRESS") as Address;
const scheduler = privateKeyToAccount(
  requireEnv("SCHEDULER_PRIVATE_KEY") as Hex,
);
const addresses = new Set<Address>([scheduler.address]);
const mutations = new Map<number, MutationEvent>();

const ffca = await createFFCA<
  typeof TOKEN_STORAGE_LAYOUT,
  typeof tokenMutations,
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
  mutations: tokenMutations,
});

ffca.on("mutation", (mutation) => {
  mutations.set(mutation.id, mutation);
});

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`;
}

const bootId = crypto.randomUUID();

const server = Bun.serve({
  port: Number(process.env.PORT ?? "3000"),
  routes: {
    "/": index,
    "/api/config": () => Response.json({ chainId, tokenAddress }),
    "/api/boot-id": () => Response.json({ id: bootId }),
    "/api/state": async () => {
      const accounts: Record<Address, { balance: string; nonce: string }> = {};
      for (const address of addresses) {
        const account = ffca.state.accounts[address];
        accounts[address] = {
          balance: (await account.balance).toString(),
          nonce: (await account.nonce).toString(),
        };
      }
      return Response.json({
        totalSupply: (await ffca.state.totalSupply).toString(),
        accounts,
      });
    },
    "/api/account/:address": async (req) => {
      const account = ffca.state.accounts[req.params.address as Address];
      return Response.json({
        balance: (await account.balance).toString(),
        nonce: (await account.nonce).toString(),
      });
    },
    "/api/addresses": () => Response.json([...addresses]),
    "/api/sign-in": {
      POST: async () => {
        const privateKey = generatePrivateKey();
        const account = privateKeyToAccount(privateKey);
        const mint = {
          to: account.address,
          amount: 1_000n,
          nonce: await ffca.state.accounts[account.address].nonce,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 60),
        };
        const mutation = await ffca.execute({
          name: "Mint",
          params: mint,
          signature: await signMint({
            account,
            token: tokenAddress,
            chainId,
            mint,
          }),
        });
        addresses.add(account.address);
        return Response.json({
          address: account.address,
          privateKey,
          bootId,
          mutationId: mutation.id,
        });
      },
    },
    "/api/mint": {
      POST: async (req) => {
        const body = (await req.json()) as {
          to: Address;
          amount: string;
          nonce: string;
          deadline: string;
          signature: TokenSignature;
        };
        const mutation = await ffca.execute({
          name: "Mint",
          params: {
            to: body.to,
            amount: BigInt(body.amount),
            nonce: BigInt(body.nonce),
            deadline: BigInt(body.deadline),
          },
          signature: body.signature,
        });
        addresses.add(body.to);
        return Response.json(mutation);
      },
    },
    "/api/transfer": {
      POST: async (req) => {
        const body = (await req.json()) as {
          from: Address;
          to: Address;
          amount: string;
          nonce: string;
          deadline: string;
          signature: TokenSignature;
        };
        const mutation = await ffca.execute({
          name: "Transfer",
          params: {
            from: body.from,
            to: body.to,
            amount: BigInt(body.amount),
            nonce: BigInt(body.nonce),
            deadline: BigInt(body.deadline),
          },
          signature: body.signature,
        });
        addresses.add(body.from);
        addresses.add(body.to);
        return Response.json(mutation);
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
