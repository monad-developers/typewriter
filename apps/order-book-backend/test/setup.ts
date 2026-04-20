import { afterAll, beforeAll } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql";
import { Instance, Server } from "prool";
import type { Address, Hex } from "viem";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import Exchange from "../../order-book-contracts/out/Exchange.sol/Exchange.json";
import * as schema from "../src/app-schema";
import { migrate } from "../src/migrate";

const SCHEDULER_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
export const SCHEDULER_ACCOUNT = privateKeyToAccount(SCHEDULER_PK);

export const RPC_URL = "http://localhost:8545/1";

export const testClient = createTestClient({
  chain: anvil,
  mode: "anvil",
  transport: http(RPC_URL),
});

export const walletClient = createWalletClient({
  chain: anvil,
  transport: http(RPC_URL),
  account: SCHEDULER_ACCOUNT,
});

const publicClient = createPublicClient({
  chain: anvil,
  transport: http(RPC_URL),
});

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/postgres";

let teardown: (() => Promise<void>) | undefined;
let adminClient: Bun.SQL | undefined;

export async function deployExchange(): Promise<Address> {
  const hash = await walletClient.deployContract({
    abi: Exchange.abi,
    bytecode: Exchange.bytecode.object as Hex,
    args: [SCHEDULER_ACCOUNT.address],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return receipt.contractAddress!;
}

export async function createTestDb(
  chainId: number,
  exchangeAddress: Address,
): Promise<ReturnType<typeof drizzle<typeof schema>>> {
  const client = new Bun.SQL({ url: TEST_DATABASE_URL, max: 1 });
  const db = drizzle({ client, schema, casing: "snake_case" });
  // @ts-expect-error migrate's BunSQLDatabase type doesn't carry schema
  await migrate(db, chainId, exchangeAddress);
  return db;
}

beforeAll(async () => {
  const server = Server.create({
    instance: Instance.anvil(),
    port: 8545,
  });
  teardown = await server.start();
  process.on("exit", () => teardown?.());

  adminClient = new Bun.SQL({ url: TEST_DATABASE_URL, max: 1 });
  const rows = await adminClient`
    SELECT nspname FROM pg_namespace
    WHERE nspname LIKE 'd\\_%' ESCAPE '\\'
  `;
  for (const row of rows as Array<{ nspname: string }>) {
    await adminClient.unsafe(`DROP SCHEMA "${row.nspname}" CASCADE`);
  }
  await adminClient`DROP TABLE IF EXISTS deployments CASCADE`;
  await adminClient`DROP SCHEMA IF EXISTS drizzle CASCADE`;
});

afterAll(async () => {
  await adminClient?.close();
  await teardown?.();
});
