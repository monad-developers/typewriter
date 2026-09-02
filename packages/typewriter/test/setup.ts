import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { $ } from "bun";
import { Instance, Server } from "prool";
import type { Hex } from "viem";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";

// Anvil's first default account.
export const SCHEDULER_ACCOUNT = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

// Anvil's second default account — used as the user-side signer in tests so
// scheduler ≠ signer matches real-app usage.
export const USER_PRIVATE_KEY: Hex =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const USER_ACCOUNT = privateKeyToAccount(USER_PRIVATE_KEY);

// Anvil's third and fourth — used when a test needs two distinct user
// identities (e.g. multi-account Harness tests).
export const ALICE_PRIVATE_KEY: Hex =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
export const ALICE_ACCOUNT = privateKeyToAccount(ALICE_PRIVATE_KEY);
export const BOB_PRIVATE_KEY: Hex =
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
export const BOB_ACCOUNT = privateKeyToAccount(BOB_PRIVATE_KEY);

// Deterministic P-256 private key for native credential tests. P-256 keys are
// not Anvil EOAs; Typewriter authenticates them through its account storage.
export const P256_PRIVATE_KEY: Hex =
  "0x1db0e88607f75d3f7fd7fd568b6929551c25e893aa1cbdce2536ad478d8f43b1";

export let TEST_RPC_URL!: string;
const testEnv = process.env as {
  DATABASE_URL?: string;
};
const TEST_ADMIN_DB_CONNECTION = new Bun.SQL({
  url: testEnv.DATABASE_URL,
  max: 1,
});
export let TEST_DB_CONNECTION!: Bun.SQL;
export let TEST_DB_URL!: string;

function quoteTestIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid test database identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function testDatabaseUrl(databaseName: string): string {
  if (testEnv.DATABASE_URL === undefined) {
    throw new Error("DATABASE_URL is required for Postgres tests");
  }

  const databaseUrl = new URL(testEnv.DATABASE_URL);
  databaseUrl.pathname = `/${databaseName}`;
  return databaseUrl.toString();
}

export async function dropTestDatabase(databaseName: string): Promise<void> {
  await TEST_ADMIN_DB_CONNECTION`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = ${databaseName}
      AND pid <> pg_backend_pid()
  `;
  await TEST_ADMIN_DB_CONNECTION.unsafe(
    `DROP DATABASE IF EXISTS ${quoteTestIdentifier(databaseName)}`,
  );
}

export async function createTestDatabaseConnection(
  databaseName: string,
): Promise<Bun.SQL> {
  await dropTestDatabase(databaseName);
  await TEST_ADMIN_DB_CONNECTION.unsafe(
    `CREATE DATABASE ${quoteTestIdentifier(databaseName)}`,
  );
  return new Bun.SQL({ url: testDatabaseUrl(databaseName), max: 2 });
}

export let TEST_CLIENT!: ReturnType<typeof createTestClient>;

export let TEST_PUBLIC_CLIENT!: ReturnType<typeof createPublicClient>;
export let TEST_WALLET_CLIENT!: ReturnType<typeof createWalletClient>;

// packages/typewriter/bunfig.toml's `[test] preload` points at this file, so run
// tests from this package or through `bun run --filter typewriter test`.
// Each test deploys its own contracts via the helpers in ./utils.

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

beforeAll(async () => {
  // Verify forge is available before trying to use it; otherwise the build
  // failure is cryptic.
  try {
    await $`forge --version`.quiet();
  } catch {
    throw new Error(
      "forge not found on PATH. typewriter tests require Foundry — install via `foundryup` (https://book.getfoundry.sh/getting-started/installation).",
    );
  }

  // Compile test contracts. Forge caches incrementally, so this is fast
  // after the first run.
  try {
    await $`forge build`.cwd(`${import.meta.dir}/contracts`).quiet();
  } catch (e) {
    throw new Error(`forge build failed:\n${e}`);
  }

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
      blockTime: 0.4,
    }),
    port,
  });
  teardown = await server.start();
  snapshotId = await TEST_CLIENT.snapshot();
});

// Revert chain state between every test, regardless of file.
beforeEach(async () => {
  testDatabaseName = `typewriter_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  TEST_DB_URL = testDatabaseUrl(testDatabaseName);
  TEST_DB_CONNECTION = await createTestDatabaseConnection(testDatabaseName);
  await TEST_CLIENT.revert({ id: snapshotId });
  snapshotId = await TEST_CLIENT.snapshot();
});

afterEach(async () => {
  // Flush any transaction submitted by a runtime immediately before its scope
  // closed so it cannot remain pending and collide with the next test nonce.
  await TEST_CLIENT.mine({ blocks: 1 });
  await TEST_DB_CONNECTION.close();
  await dropTestDatabase(testDatabaseName);
});

afterAll(async () => {
  await TEST_ADMIN_DB_CONNECTION.close();
  await teardown();
});
