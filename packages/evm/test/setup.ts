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

export let TEST_RPC_URL!: string;

export let TEST_CLIENT!: ReturnType<typeof createTestClient>;

export let TEST_PUBLIC_CLIENT!: ReturnType<typeof createPublicClient>;

export let TEST_WALLET_CLIENT!: ReturnType<typeof createWalletClient>;

let teardown!: () => Promise<void>;
let snapshotId!: Hex;

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
    account: SCHEDULER_ACCOUNT,
    chain: anvil,
    transport: http(TEST_RPC_URL),
  });

  const server = Server.create({
    instance: Instance.anvil({
      chainId: 31337,
      binary: `${import.meta.dir}/bin/anvil-monad`,
    }),
    port,
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
