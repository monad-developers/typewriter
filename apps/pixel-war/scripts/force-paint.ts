/**
 * Lands a paint without the server's cooperation.
 *
 * Force inclusion is Typewriter's escape hatch: a user puts a signed mutation
 * onchain with `enqueue()`, and once `FORCE_INCLUSION_DELAY` blocks have passed
 * anyone can settle it with `forceExecute()`. The server cannot suppress it — and
 * unlike normal play, the caller pays their own gas.
 *
 * Usage, from apps/pixel-war (needs a funded key on the target chain):
 *   PRIVATE_KEY=0x... X=64 Y=64 COLOR=1 bun run force-paint
 *
 * Optional: WAIT=1 polls until the delay elapses and then calls forceExecute.
 */
import { MAX_DEADLINE, messageFor, PALETTE } from "pixel-war-sdk";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  type Hex,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  nonceFor,
  normalizeSignatureForContract,
  secp256k1AccountId,
  signMutation,
} from "../src/app";
import { CHAIN, PIXEL_WAR_ADDRESS, RPC_URL } from "../src/constants";

const PIXEL_WAR_ABI = parseAbi([
  "function enqueue(uint8 mutation, bytes mutationData, bytes signatureData) returns (uint256)",
  "function forceExecute(uint256 index)",
  "event ForceInclusionQueued(uint256 index, uint8 mutation, bytes mutationData, bytes signatureData, uint256 enqueuedBlock)",
]);

/// Matches the `Mutation` enum in PixelWar.sol.
const PAINT_TAG = 5;
const FORCE_INCLUSION_DELAY = 658n;

if (process.env.PRIVATE_KEY === undefined) {
  throw new Error("PRIVATE_KEY env var is required");
}

const account = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
const accountId = secp256k1AccountId(account.address);
const x = Number(process.env.X ?? 64);
const y = Number(process.env.Y ?? 64);
const color = Number(process.env.COLOR ?? 1);
const nonceLane = BigInt(process.env.NONCE_LANE ?? 7);
const nonceSeq = BigInt(process.env.NONCE_SEQ ?? 0);

const publicClient = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL),
});
const walletClient = createWalletClient({
  account,
  chain: CHAIN,
  transport: http(RPC_URL),
});

const params = messageFor("Paint", {
  x,
  y,
  color,
  nonce: nonceFor(nonceLane, nonceSeq),
  deadline: MAX_DEADLINE,
});

const signed = await signMutation({
  name: "Paint",
  params,
  account,
  signerAccountId: accountId,
  keyId: 1n,
  contract: PIXEL_WAR_ADDRESS as Address,
  chainId: CHAIN.id,
});

// `enqueue` takes the same ABI-encoded payloads the scheduler would submit.
const mutationData = encodeAbiParameters(
  [
    {
      type: "tuple",
      components: [
        { name: "x", type: "uint16" },
        { name: "y", type: "uint16" },
        { name: "color", type: "uint8" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
  ],
  [
    {
      x,
      y,
      color,
      nonce: nonceFor(nonceLane, nonceSeq),
      deadline: MAX_DEADLINE,
    },
  ],
);

const signature = normalizeSignatureForContract(signed.signature);
const signatureData = encodeAbiParameters(
  [
    {
      type: "tuple",
      components: [
        { name: "account", type: "bytes32" },
        { name: "keyId", type: "uint64" },
        { name: "rawSignature", type: "bytes" },
      ],
    },
  ],
  [
    {
      account: signature.account,
      keyId: signature.keyId,
      rawSignature: signature.rawSignature,
    },
  ],
);

console.log(
  `enqueueing paint (${x}, ${y}) color ${color} ${PALETTE[color]} as ${accountId}`,
);

const hash = await walletClient.writeContract({
  address: PIXEL_WAR_ADDRESS as Address,
  abi: PIXEL_WAR_ABI,
  functionName: "enqueue",
  args: [PAINT_TAG, mutationData, signatureData],
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`enqueued in block ${receipt.blockNumber} (tx ${hash})`);

const readyAt = receipt.blockNumber + FORCE_INCLUSION_DELAY;
console.log(
  `the server should pick this up on its own. forceExecute is callable from block ${readyAt}`,
);

if (process.env.WAIT !== "1") process.exit(0);

// The queue index is the first indexed value in the event; decode it from the
// receipt so the caller does not have to guess.
const logs = await publicClient.getContractEvents({
  address: PIXEL_WAR_ADDRESS as Address,
  abi: PIXEL_WAR_ABI,
  eventName: "ForceInclusionQueued",
  blockHash: receipt.blockHash,
});
const index = logs.at(-1)?.args.index;
if (index === undefined) throw new Error("ForceInclusionQueued log not found");

while ((await publicClient.getBlockNumber()) < readyAt) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

const forceHash = await walletClient.writeContract({
  address: PIXEL_WAR_ADDRESS as Address,
  abi: PIXEL_WAR_ABI,
  functionName: "forceExecute",
  args: [index],
});
await publicClient.waitForTransactionReceipt({ hash: forceHash });
console.log(`forceExecute landed (tx ${forceHash})`);
