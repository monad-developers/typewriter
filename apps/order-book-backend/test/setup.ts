import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { Instance, Server } from "prool";
import type { Address, Hex } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { createState, type State } from "../src/exchange";
import { type RuntimeHandle, startRuntime } from "../src/runtime";

import Exchange from "../../order-book-contracts/out/Exchange.sol/Exchange.json";

const SCHEDULER_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const SCHEDULER_ACCOUNT = privateKeyToAccount(SCHEDULER_PK);

export const RPC_URL = "http://localhost:8545/1";

let teardown: (() => Promise<void>) | undefined;
let snapshotId: Hex;

export let exchangeAddress: Address;
export let state: State<bigint>;
export let handle: RuntimeHandle;

export async function deployExchange(): Promise<Address> {
  const walletClient = createWalletClient({
    account: SCHEDULER_ACCOUNT,
    chain: anvil,
    transport: http(RPC_URL),
  });
  const publicClient = createPublicClient({
    chain: anvil,
    transport: http(RPC_URL),
  });

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
  exchangeAddress = await deployExchange();
});

afterAll(async () => {
  await teardown?.();
});

beforeEach(async () => {
  const publicClient = createPublicClient({
    chain: anvil,
    transport: http(RPC_URL),
  });
  snapshotId = await publicClient.request({
    method: "evm_snapshot" as "evm_snapshot",
  } as never);

  state = createState();
  handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });
});

afterEach(async () => {
  await handle.stop();
  const publicClient = createPublicClient({
    chain: anvil,
    transport: http(RPC_URL),
  });
  await publicClient.request({
    method: "evm_revert" as "evm_revert",
    params: [snapshotId],
  } as never);
});
