import {
  createFFCA,
  type FFCAConfig,
  type MutationEvent,
  type MutationStatus,
} from "ffca";
import type { Abi, Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import index from "../frontend/index.html";
import {
  signMint,
  TOKEN_DOMAIN,
  type TokenSignature,
  tokenMutations,
} from "./app";
import { TOKEN_STORAGE_LAYOUT } from "./storage-layout";

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    },
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} env var is required`);
  }
  return value;
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`;
}

const rpcUrl = requireEnv("BUN_PUBLIC_RPC_URL");
const chainId = Number(process.env.CHAIN_ID ?? "31337");
const tokenAddress = requireEnv("TOKEN_ADDRESS") as Address;
const scheduler = privateKeyToAccount(
  requireEnv("SCHEDULER_PRIVATE_KEY") as Hex,
);
const database = { url: requireEnv("DATABASE_URL"), maxConnections: 25 };
const artifact = await Bun.file(
  `${import.meta.dir}/../contracts/out/Token.sol/Token.json`,
).json();
const bootId = crypto.randomUUID();
const addresses = new Set<Address>([scheduler.address]);
const mutations = new Map<number, MutationEvent>();
const config = {
  address: tokenAddress,
  abi: artifact.abi as Abi,
  storageLayout: TOKEN_STORAGE_LAYOUT,
  account: scheduler,
  chainId,
  rpcUrl,
  database,
  domain: TOKEN_DOMAIN,
  sequencing: { order: "fifo" },
  mutations: tokenMutations,
} as const satisfies FFCAConfig;
const ffca = await createFFCA(config);
ffca.on("mutation", (mutation) => {
  mutations.set(mutation.id, mutation);
});

const server = Bun.serve({
  port: Number(process.env.PORT ?? "3000"),
  routes: {
    "/": index,
    "/health": () => json({ ok: true }),
    "/api/config": () => json({ chainId, tokenAddress }),
    "/api/boot-id": () => json({ id: bootId }),
    "/api/state": async () => {
      const accounts: Record<Address, { balance: bigint; nonce: bigint }> = {};
      for (const address of addresses) {
        const account = ffca.state.accounts[address];
        accounts[address] = {
          balance: await account.balance,
          nonce: await account.nonce,
        };
      }
      return json({ totalSupply: await ffca.state.totalSupply, accounts });
    },
    "/api/account/:address": async (req) => {
      const account = ffca.state.accounts[req.params.address as Address];
      return json({
        balance: await account.balance,
        nonce: await account.nonce,
      });
    },
    "/api/addresses": () => json([...addresses]),
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
          args: mint,
          signature: await signMint({
            account,
            token: tokenAddress,
            chainId,
            mint,
          }),
        });
        addresses.add(account.address);
        return json({
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
          args: {
            to: body.to,
            amount: BigInt(body.amount),
            nonce: BigInt(body.nonce),
            deadline: BigInt(body.deadline),
          },
          signature: body.signature,
        });
        addresses.add(body.to);
        return json(mutation);
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
          args: {
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
        return json(mutation);
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
