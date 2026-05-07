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

// Port chosen to avoid colliding with ffca/order-book test suites.
export const TEST_RPC_URL = "http://localhost:18547/1";

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
  account: SCHEDULER_ACCOUNT,
  chain: anvil,
  transport: http(TEST_RPC_URL),
});

let teardown!: () => Promise<void>;
let snapshotId!: Hex;

beforeAll(async () => {
  try {
    await $`forge --version`.quiet();
  } catch {
    throw new Error(
      "forge not found on PATH. evm Solidity tests require Foundry — install via `foundryup` (https://book.getfoundry.sh/getting-started/installation).",
    );
  }

  try {
    await $`forge build`.cwd(`${import.meta.dir}/contracts`).quiet();
  } catch (error) {
    throw new Error(`forge build failed:\n${error}`);
  }

  const server = Server.create({
    instance: Instance.anvil({ chainId: 31337 }),
    port: 18547,
  });
  teardown = await server.start();
  snapshotId = await TEST_CLIENT.snapshot();
});

beforeEach(async () => {
  await TEST_CLIENT.revert({ id: snapshotId });
  snapshotId = await TEST_CLIENT.snapshot();
});

afterAll(async () => {
  await teardown();
});
