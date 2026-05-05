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

// One-time setup at module load. bun:test imports `setup.ts` once across all
// test files in a run, so this runs once: compile contracts, boot anvil,
// deploy Counter. The per-file snapshot/revert lives in beforeEach below.

// Compile test contracts. Forge caches incrementally, so this is fast after
// the first run. If forge isn't installed, the error surfaces here.
const buildProc = Bun.spawn(["forge", "build"], {
  cwd: `${import.meta.dir}/contracts`,
  stderr: "pipe",
  stdout: "pipe",
});
const buildExit = await buildProc.exited;
if (buildExit !== 0) {
  const stderr = await new Response(buildProc.stderr).text();
  throw new Error(`forge build failed:\n${stderr}`);
}

// Boot anvil on a port distinct from order-book-backend's tests so the two
// suites can run in parallel.
const server = Server.create({ instance: Instance.anvil(), port: 8546 });
const teardown = await server.start();
process.on("exit", () => teardown());

const artifact = await Bun.file(
  `${import.meta.dir}/contracts/out/Counter.sol/Counter.json`,
).json();
// biome-ignore lint/suspicious/noExplicitAny: forge artifact JSON shape
export const counterAbi: any = artifact.abi;

const deployHash = await walletClient.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object as Hex,
  args: [],
});
const deployReceipt = await publicClient.waitForTransactionReceipt({
  hash: deployHash,
});
if (
  deployReceipt.contractAddress === null ||
  deployReceipt.contractAddress === undefined
) {
  throw new Error("Counter deploy missing address");
}
export const counterAddress: Address = deployReceipt.contractAddress;

let snapshotId: Hex = await testClient.snapshot();

// Revert chain state to the last snapshot and take a fresh one. Test files
// call this from their own `beforeEach` if they want isolation; bun:test
// scopes hooks to the file that registered them, so a `beforeEach` here
// wouldn't apply to other importers.
export async function resetChain(): Promise<void> {
  await testClient.revert({ id: snapshotId });
  snapshotId = await testClient.snapshot();
}
