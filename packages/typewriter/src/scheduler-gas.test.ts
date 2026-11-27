import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Effect } from "effect";
import { AbiFunction, AbiParameters, type Address, Hex } from "ox";
import { createEVM, type ExecuteResult, type Spec } from "typewriter-evm";
import { privateKeyToAccount } from "viem/accounts";
import {
  CREATE2_DEPLOYER,
  deploymentAddress,
  deploymentInitcode,
  deploymentSalt,
  genesisCredentials,
} from "./deploy";
import { encodeExecuteCalldata } from "./encoding";
import {
  HARDFORKS,
  SCHEDULER_AUTHORIZATION_GAS,
  type SchedulerCheckGas,
  SIGNATURE_CALLDATA_TOKENS,
} from "./gas";
import {
  EXECUTE_EIP712_TYPES,
  SCHEDULER_AUTHORIZATION_ABI_PARAMS,
  TYPEWRITER_EIP712_DOMAIN,
} from "./typewriter-constants";

/** The runtime code of `CREATE2_DEPLOYER`. */
const CREATE2_DEPLOYER_CODE =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

const ROOT = privateKeyToAccount(`0x${"71".repeat(32)}`);
const SCHEDULER = privateKeyToAccount(`0x${"72".repeat(32)}`);
const RELAYER = privateKeyToAccount(`0x${"73".repeat(32)}`);
const CHAIN_ID = 10143;
const TIMESTAMP = 1_800_000_000n;
const FROM_HASH = `0x${"a1".repeat(32)}` as const;
const TO_HASH = `0x${"b2".repeat(32)}` as const;

const HARNESS_PARAMS = [
  { type: "bytes32" },
  { type: "bytes32" },
  { type: "uint40" },
  { type: "tuple", components: SCHEDULER_AUTHORIZATION_ABI_PARAMS },
] as const;
const MEASURE_CHECK = AbiFunction.from({
  type: "function",
  name: "measureCheck",
  inputs: HARNESS_PARAMS,
  outputs: [],
  stateMutability: "view",
});
const MEASURE_NOTHING = AbiFunction.from({
  type: "function",
  name: "measureNothing",
  inputs: HARNESS_PARAMS,
  outputs: [],
  stateMutability: "view",
});

const harnessBytecode = await (async () => {
  const out = await mkdtemp(join(tmpdir(), "typewriter-harness-"));
  try {
    const root = join(import.meta.dir, "../test/contracts");
    await $`forge build --root ${root} --out ${out}/out --cache-path ${out}/cache`.quiet();
    const artifact = await Bun.file(
      `${out}/out/SchedulerCheckHarness.sol/SchedulerCheckHarness.json`,
    ).json();
    return artifact.bytecode.object as Hex.Hex;
  } finally {
    await rm(out, { recursive: true, force: true });
  }
})();

/** The gas a `GasUsed` revert reports. */
const gasUsed = (result: ExecuteResult) => {
  if (result.status !== "revert") {
    throw new Error(`expected a GasUsed revert, got ${result.status}`);
  }
  return Number(
    AbiParameters.decode([{ type: "uint256" }], Hex.slice(result.data, 4))[0],
  );
};

/**
 * What `execute`'s scheduler check costs under `spec`, on the fast path (the
 * credential's address sends the call, without a signature) and on the
 * secp256k1 path (the relayer sends it, with the scheduler's 65-byte
 * signature), for the scheduler's credential: the root's if `rootIsScheduler`,
 * else an executor's after the root's.
 */
const measureSchedulerCheck = (spec: Spec, rootIsScheduler: boolean) =>
  Effect.gen(function* () {
    const evm = yield* createEVM({
      spec,
      chain_id: CHAIN_ID,
      block: { timestamp: Hex.fromNumber(TIMESTAMP) },
      accounts: {
        [CREATE2_DEPLOYER]: { code: CREATE2_DEPLOYER_CODE },
        [RELAYER.address]: { balance: Hex.fromNumber(10n ** 24n) },
        [SCHEDULER.address]: { balance: Hex.fromNumber(10n ** 24n) },
      },
    });
    const root = rootIsScheduler ? SCHEDULER.address : ROOT.address;
    const credentials = genesisCredentials(root, SCHEDULER.address);
    const credentialID = BigInt(credentials.length - 1);
    const salt = deploymentSalt("scheduler_gas");
    const initcode = deploymentInitcode(harnessBytecode, credentials);
    const harness = deploymentAddress(salt, initcode);
    const deployed = yield* evm.execute({
      from: RELAYER.address,
      to: CREATE2_DEPLOYER,
      data: Hex.concat(salt, initcode),
    });
    if (deployed.status !== "success") {
      throw new Error(`harness deployment failed: ${deployed.status}`);
    }

    const signature = yield* Effect.promise(() =>
      SCHEDULER.signTypedData({
        domain: {
          ...TYPEWRITER_EIP712_DOMAIN,
          chainId: CHAIN_ID,
          verifyingContract: harness,
        },
        types: EXECUTE_EIP712_TYPES,
        primaryType: "Execute",
        message: {
          fromExecutionHash: FROM_HASH,
          toExecutionHash: TO_HASH,
          timestamp: Number(TIMESTAMP),
          relayer: RELAYER.address,
        },
      }),
    );

    const measure = (
      from: Address.Address,
      authorization: { credentialID: bigint; signature: Hex.Hex },
    ) =>
      Effect.gen(function* () {
        const args = [
          FROM_HASH,
          TO_HASH,
          Number(TIMESTAMP),
          authorization,
        ] as const;
        const call = (
          fn: typeof MEASURE_CHECK | typeof MEASURE_NOTHING,
          warmFrom?: ExecuteResult,
        ) =>
          evm.execute({
            from,
            to: harness,
            data: AbiFunction.encodeData(fn as typeof MEASURE_CHECK, args),
            access_list: warmFrom?.access_list,
          });
        const overhead = gasUsed(yield* call(MEASURE_NOTHING));
        const cold = yield* call(MEASURE_CHECK);
        const warm = yield* call(MEASURE_CHECK, cold);
        return {
          cold: gasUsed(cold) - overhead,
          warm: gasUsed(warm) - overhead,
        } satisfies SchedulerCheckGas;
      });

    return {
      sender: yield* measure(SCHEDULER.address, {
        credentialID,
        signature: "0x",
      }),
      signature: yield* measure(RELAYER.address, { credentialID, signature }),
    };
  });

/**
 * The EIP-7623 tokens that a 65-byte signature, every byte nonzero, adds to
 * `execute`'s calldata over an empty one.
 */
const measureSignatureTokens = () => {
  const tokens = (signature: Hex.Hex) => {
    const calldata = encodeExecuteCalldata(
      FROM_HASH,
      TIMESTAMP,
      { mutations: [], mutationData: [], authorizationData: [] },
      [],
      { credentialID: 1n, signature },
    );
    let count = 0;
    for (const byte of Hex.toBytes(calldata)) count += byte === 0 ? 1 : 4;
    return count;
  };
  return tokens(`0x${"ff".repeat(65)}`) - tokens("0x");
};

test("SCHEDULER_AUTHORIZATION_GAS is what revm charges for the scheduler check under each hardfork", async () => {
  const measured = await Effect.runPromise(
    Effect.forEach(HARDFORKS, (spec) =>
      Effect.gen(function* () {
        // The scheduler's credential is the root's, credential 0, or an
        // executor after it, credential 1. The table takes the larger.
        const asRoot = yield* measureSchedulerCheck(spec, true);
        const asExecutor = yield* measureSchedulerCheck(spec, false);
        const max = (pick: (m: typeof asRoot) => SchedulerCheckGas) => ({
          cold: Math.max(pick(asRoot).cold, pick(asExecutor).cold),
          warm: Math.max(pick(asRoot).warm, pick(asExecutor).warm),
        });
        return [
          spec,
          { sender: max((m) => m.sender), signature: max((m) => m.signature) },
        ] as const;
      }),
    ),
  );
  // biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
  if (process.env["PRINT_GAS_TABLE"]) console.log(JSON.stringify(measured));
  expect(Object.fromEntries(measured)).toEqual(SCHEDULER_AUTHORIZATION_GAS);
  expect(measureSignatureTokens()).toBe(SIGNATURE_CALLDATA_TOKENS);
});
