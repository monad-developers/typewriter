import { afterAll, beforeAll, beforeEach } from "bun:test";
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

// Port chosen to avoid colliding with order-book-backend's tests so the two
// suites can run in parallel.
export const TEST_RPC_URL = "http://localhost:8545/1";

export const TEST_CLIENT = createTestClient({
  chain: anvil,
  mode: "anvil",
  transport: http(TEST_RPC_URL),
});

export const TEST_PUBLIC_CLIENT = createPublicClient({
  chain: anvil,
  transport: http(TEST_RPC_URL),
});
export const TEST_WALLET_CLIENT = createWalletClient({
  chain: anvil,
  transport: http(TEST_RPC_URL),
  account: SCHEDULER_ACCOUNT,
});

// bunfig.toml's `[test] preload` points at this file, so the hooks below
// fire globally — beforeAll once at run start, afterAll once at run end.
// Each test deploys its own contracts via the helpers in ./utils.

let teardown!: () => Promise<void>;
let snapshotId!: Hex;

beforeAll(async () => {
  // Verify forge is available before trying to use it; otherwise the build
  // failure is cryptic.
  try {
    await $`forge --version`.quiet();
  } catch {
    throw new Error(
      "forge not found on PATH. ffca tests require Foundry — install via `foundryup` (https://book.getfoundry.sh/getting-started/installation).",
    );
  }

  // Compile test contracts. Forge caches incrementally, so this is fast
  // after the first run.
  try {
    await $`forge build`.cwd(`${import.meta.dir}/contracts`).quiet();
  } catch (e) {
    throw new Error(`forge build failed:\n${e}`);
  }

  const server = Server.create({ instance: Instance.anvil(), port: 8545 });
  teardown = await server.start();
  snapshotId = await TEST_CLIENT.snapshot();
});

// Revert chain state between every test, regardless of file.
beforeEach(async () => {
  await TEST_CLIENT.revert({ id: snapshotId });
  snapshotId = await TEST_CLIENT.snapshot();
});

afterAll(async () => {
  await teardown();
});
