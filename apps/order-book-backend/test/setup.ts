import { afterAll, beforeAll } from "bun:test";
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

let teardown: (() => Promise<void>) | undefined;

export async function deployExchange(): Promise<Address> {
  const hash = await walletClient.deployContract({
    abi: Exchange.abi,
    bytecode: Exchange.bytecode.object as Hex,
    args: [SCHEDULER_ACCOUNT.address],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return receipt.contractAddress!;
}

beforeAll(async () => {
  const server = Server.create({
    instance: Instance.anvil(),
    port: 8545,
  });
  teardown = await server.start();
  process.on("exit", () => teardown?.());
});

afterAll(async () => {
  await teardown?.();
});
