import { afterAll, beforeAll, beforeEach } from "bun:test";
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

// Anvil's first default account.
const SCHEDULER_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
export const schedulerAccount = privateKeyToAccount(SCHEDULER_PK);

const RPC_URL = "http://localhost:8546/1";
export const rpcUrl = RPC_URL;

export const testClient = createTestClient({
  chain: anvil,
  mode: "anvil",
  transport: http(RPC_URL),
});

const publicClient = createPublicClient({
  chain: anvil,
  transport: http(RPC_URL),
});
const walletClient = createWalletClient({
  chain: anvil,
  transport: http(RPC_URL),
  account: schedulerAccount,
});

export let counterAddress: Address;
// biome-ignore lint/suspicious/noExplicitAny: forge artifact JSON shape
export let counterAbi: any;

let teardown: (() => Promise<void>) | undefined;
let snapshotId: Hex;

beforeAll(async () => {
  // Compile the test contracts. Forge caches incrementally, so this is fast
  // after the first run. If forge isn't installed, the error surfaces here.
  const proc = Bun.spawn(["forge", "build"], {
    cwd: `${import.meta.dir}/contracts`,
    stderr: "pipe",
    stdout: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`forge build failed:\n${stderr}`);
  }

  // Boot anvil on a port distinct from order-book-backend's tests so the two
  // suites can run in parallel.
  const server = Server.create({ instance: Instance.anvil(), port: 8546 });
  teardown = await server.start();
  process.on("exit", () => teardown?.());

  // Deploy Counter once; tests revert to this snapshot for isolation.
  const artifact = await Bun.file(
    `${import.meta.dir}/contracts/out/Counter.sol/Counter.json`,
  ).json();
  counterAbi = artifact.abi;
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as Hex,
    args: [],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (
    receipt.contractAddress === null ||
    receipt.contractAddress === undefined
  ) {
    throw new Error("Counter deploy missing address");
  }
  counterAddress = receipt.contractAddress;

  snapshotId = await testClient.snapshot();
});

beforeEach(async () => {
  await testClient.revert({ id: snapshotId });
  snapshotId = await testClient.snapshot();
});

afterAll(async () => {
  await teardown?.();
});
