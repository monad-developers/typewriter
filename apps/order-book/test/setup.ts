import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { $ } from "bun";
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

export const SCHEDULER_PRIVATE_KEY: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const MAKER_PRIVATE_KEY: Hex =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const TAKER_PRIVATE_KEY: Hex =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

export const SCHEDULER_ACCOUNT = privateKeyToAccount(SCHEDULER_PRIVATE_KEY);
export const MAKER_ACCOUNT = privateKeyToAccount(MAKER_PRIVATE_KEY);
export const TAKER_ACCOUNT = privateKeyToAccount(TAKER_PRIVATE_KEY);

export let TEST_RPC_URL!: string;

export let TEST_CLIENT!: ReturnType<typeof createTestClient>;
export let TEST_PUBLIC_CLIENT!: ReturnType<typeof createPublicClient>;
export let TEST_WALLET_CLIENT!: ReturnType<typeof createWalletClient>;

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/postgres";

const adminConnection = new Bun.SQL({ url: TEST_DATABASE_URL, max: 1 });
export let TEST_DB_CONNECTION!: Bun.SQL;
export let TEST_DB_URL!: string;

let teardown!: () => Promise<void>;
let snapshotId!: Hex;
let testDatabaseName!: string;

function getFreePort(): number {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = server;
  server.stop(true);
  return port;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid test database identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function databaseUrl(databaseName: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function dropDatabase(databaseName: string): Promise<void> {
  await adminConnection`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = ${databaseName}
      AND pid <> pg_backend_pid()
  `;
  await adminConnection.unsafe(
    `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`,
  );
}

export async function deployOrderBook(): Promise<Address> {
  const artifact = await Bun.file(
    `${import.meta.dir}/../contracts/out/OrderBook.sol/OrderBook.json`,
  ).json();
  const hash = await TEST_WALLET_CLIENT.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as Hex,
    args: [SCHEDULER_ACCOUNT.address],
    account: SCHEDULER_ACCOUNT,
    chain: anvil,
  });
  const receipt = await TEST_PUBLIC_CLIENT.waitForTransactionReceipt({ hash });
  if (
    receipt.contractAddress === null ||
    receipt.contractAddress === undefined
  ) {
    throw new Error("OrderBook deploy missing contract address");
  }
  return receipt.contractAddress;
}

beforeAll(async () => {
  try {
    await $`forge --version`.quiet();
  } catch {
    throw new Error("forge not found on PATH. Install Foundry with foundryup.");
  }
  await $`forge build`.cwd(`${import.meta.dir}/../contracts`).quiet();

  const port = getFreePort();
  TEST_RPC_URL = `http://localhost:${port}/1`;
  TEST_CLIENT = createTestClient({
    chain: anvil,
    mode: "anvil",
    transport: http(TEST_RPC_URL),
  });
  TEST_PUBLIC_CLIENT = createPublicClient({
    chain: anvil,
    transport: http(TEST_RPC_URL),
  });
  TEST_WALLET_CLIENT = createWalletClient({
    chain: anvil,
    transport: http(TEST_RPC_URL),
    account: SCHEDULER_ACCOUNT,
  });

  const server = Server.create({
    instance: Instance.anvil({
      binary: `${import.meta.dir}/bin/anvil-monad`,
    }),
    port,
  });
  teardown = await server.start();
  snapshotId = await TEST_CLIENT.snapshot();
});

beforeEach(async () => {
  testDatabaseName = `order_book_typewriter_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await dropDatabase(testDatabaseName);
  await adminConnection.unsafe(
    `CREATE DATABASE ${quoteIdentifier(testDatabaseName)}`,
  );
  TEST_DB_URL = databaseUrl(testDatabaseName);
  TEST_DB_CONNECTION = new Bun.SQL({
    url: TEST_DB_URL,
    max: 4,
  });
  await TEST_CLIENT.revert({ id: snapshotId });
  snapshotId = await TEST_CLIENT.snapshot();
});

afterEach(async () => {
  await TEST_DB_CONNECTION.close();
  await dropDatabase(testDatabaseName);
});

afterAll(async () => {
  await adminConnection.close();
  await teardown();
});
