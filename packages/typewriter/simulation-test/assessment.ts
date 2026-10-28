import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Effect, type Random, type Scope } from "effect";
import {
  AbiParameters,
  Address,
  Base64,
  Bytes,
  Hash,
  Hex,
  P256,
  Secp256k1,
} from "ox";
import {
  type AuthorizedMutation,
  authorizeMutation,
  deriveAccountID,
  getAuthorizationPayload,
  KeyType,
  packNonce,
} from "../src/client";
import type { TypewriterManifest } from "../src/config";
import {
  ASSESSMENT_PROJECT,
  type AssessmentMutations,
} from "./assessment-constants";
import type { Chain } from "./chain";
import { SIM } from "./index";

/** The mutations of `Assessment.sol`, without the built-in ones. */
export type AppMutationName = "A" | "B";

type Mutation<
  name extends keyof AssessmentMutations & string = keyof AssessmentMutations &
    string,
> = AuthorizedMutation<TypewriterManifest<AssessmentMutations>, name>;

/** Mutations write slots in [0, SLOT_COUNT), so later writes overwrite earlier ones. */
const SLOT_COUNT = 16;

/** The key of a mutation in the events. Every mutation of a run has its own. */
export function mutationKey(authorization: {
  accountID: Hex.Hex;
  nonce: bigint;
}): string {
  return `${authorization.accountID}:${authorization.nonce}`;
}

/** One entry of the plan. */
export type Step = {
  index: number;
  delayMs: number;
  via: "execute" | "enqueue";
  /** Executes the mutation again as soon as it is received. The second `execute` fails. */
  resubmit: boolean;
  /** Drawn from `SIM.generator.expirationsS`. See {@link signAtSubmission}. */
  expiresInS: number;
  signer: Signer;
  /** Unsigned, with a `0x` signature, until {@link signAtSubmission} signs it. */
  mutation: Mutation<AppMutationName>;
};

/** The deployment, with a `FORCE_INCLUSION_DELAY` the runtime cannot reach. */
export function deploy({
  chain,
  deployer,
}: {
  chain: Chain;
  deployer: Address.Address;
}): Effect.Effect<Address.Address, never, Scope.Scope> {
  return Effect.gen(function* () {
    // A private build directory, so that parallel runs do not share artifacts.
    const out = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "typewriter-sim-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );
    yield* Effect.promise(() =>
      $`forge build --root ${ASSESSMENT_PROJECT} --out ${out}/out --cache-path ${out}/cache`.quiet(),
    );
    const artifact = yield* Effect.promise(() =>
      Bun.file(`${out}/out/Assessment.sol/Assessment.json`).json(),
    );
    const args = AbiParameters.encode(
      AbiParameters.from(["address", "uint256"]),
      [deployer, 1_000_000n],
    );
    const hash = yield* chain.request({
      method: "eth_sendTransaction",
      params: [
        { from: deployer, data: Hex.concat(artifact.bytecode.object, args) },
      ],
    });
    yield* chain.mine(SIM.chain.genesisTimestamp);
    const receipt = yield* chain.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    });
    if (receipt?.contractAddress == null) {
      return yield* Effect.die("deploy of Assessment has no address");
    }
    return receipt.contractAddress;
  });
}

export type Signer = {
  keyType: KeyType;
  accountID: Hex.Hex;
  publicKey: Hex.Hex;
  /** Signs the EIP-712 payload of an authorization, in the encoding of `keyType`. */
  sign: (payload: Hex.Hex) => Hex.Hex;
};

const SECP256K1_SIGNATURE = AbiParameters.from(["uint8", "bytes32", "bytes32"]);
const P256_PUBLIC_KEY = AbiParameters.from(["uint256", "uint256"]);
const P256_SIGNATURE = AbiParameters.from(["uint256", "uint256"]);
const WEBAUTHN_SIGNATURE = AbiParameters.from([
  "bytes",
  "bytes",
  "uint256",
  "uint256",
  "uint256",
]);

const P256_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** Signs the hash `payload`, with a low `s`. */
function signP256(payload: Hex.Hex, privateKey: Hex.Hex) {
  const signature = P256.sign({ payload, privateKey });
  const r = BigInt(signature.r);
  const s = BigInt(signature.s);
  return { r, s: s > P256_N / 2n ? P256_N - s : s };
}

/** An authenticator data with a zero RP ID hash, user-present flag, and counter. */
const AUTHENTICATOR_DATA = Hex.concat(
  Hex.padLeft("0x0", 32),
  "0x01",
  "0x00000000",
);

/** Makes the signer of account `index` from the seed. */
export function makeSigner(index: number, keyType: KeyType): Signer {
  const privateKey = Hash.keccak256(
    Hex.fromString(`${SIM.seed}:account:${index}`),
  );

  switch (keyType) {
    case KeyType.Secp256k1: {
      const address = Address.fromPublicKey(
        Secp256k1.getPublicKey({ privateKey }),
      );
      const publicKey = AbiParameters.encode(AbiParameters.from(["address"]), [
        address,
      ]);
      const accountID = deriveAccountID({ keyType, publicKey });

      return {
        keyType,
        accountID,
        publicKey,
        sign: (payload) => {
          const { r, s, yParity } = Secp256k1.sign({ payload, privateKey });
          return AbiParameters.encode(SECP256K1_SIGNATURE, [
            27 + yParity,
            Hex.padLeft(r, 32),
            Hex.padLeft(s, 32),
          ]);
        },
      };
    }
    case KeyType.P256: {
      const { x, y } = P256.getPublicKey({ privateKey });
      const publicKey = AbiParameters.encode(P256_PUBLIC_KEY, [
        BigInt(x),
        BigInt(y),
      ]);
      const accountID = deriveAccountID({ keyType, publicKey });

      return {
        keyType,
        accountID,
        publicKey,
        // `verifyP256` checks the signature over `sha256(digest)`.
        sign: (payload) => {
          const { r, s } = signP256(Hash.sha256(payload), privateKey);
          return AbiParameters.encode(P256_SIGNATURE, [r, s]);
        },
      };
    }
    case KeyType.WebAuthnP256: {
      const { x, y } = P256.getPublicKey({ privateKey });
      const publicKey = AbiParameters.encode(P256_PUBLIC_KEY, [
        BigInt(x),
        BigInt(y),
      ]);
      const accountID = deriveAccountID({ keyType, publicKey });

      return {
        keyType,
        accountID,
        publicKey,
        // `verifyWebAuthnP256` finds the base64url digest at `challengeOffset` in
        // `clientDataJSON`, and checks the signature over
        // `sha256(authenticatorData || sha256(clientDataJSON))`.
        sign: (payload) => {
          const prefix = '{"type":"webauthn.get","challenge":"';
          const challenge = Base64.fromHex(payload, { url: true, pad: false });
          const clientDataJSON = Hex.fromString(
            `${prefix}${challenge}","origin":"https://simulation.test"}`,
          );
          const message = Hash.sha256(
            Hex.concat(AUTHENTICATOR_DATA, Hash.sha256(clientDataJSON)),
          );
          const { r, s } = signP256(message, privateKey);
          return AbiParameters.encode(WEBAUTHN_SIGNATURE, [
            AUTHENTICATOR_DATA,
            clientDataJSON,
            BigInt(Bytes.fromString(prefix).length),
            r,
            s,
          ]);
        },
      };
    }
  }
}

type Unsigned<name extends keyof AssessmentMutations & string> = Pick<
  Mutation<name>,
  "name" | "params"
> & { nonce: bigint; expiration?: bigint };

function unsignedMutation<
  const name extends keyof AssessmentMutations & string,
>(signer: Signer, mutation: Unsigned<name>) {
  return {
    expiration: 0n,
    ...mutation,
    accountID: signer.accountID,
    credentialID: 0n,
  };
}

/** The mutation with a `0x` signature, to sign later. */
function unsigned<const name extends keyof AssessmentMutations & string>(
  signer: Signer,
  mutation: Unsigned<name>,
): Mutation<name> {
  return authorizeMutation(unsignedMutation(signer, mutation), "0x");
}

function authorize<const name extends keyof AssessmentMutations & string>(
  manifest: TypewriterManifest<AssessmentMutations>,
  signer: Signer,
  mutation: Unsigned<name>,
): Mutation<name> {
  const unsigned = unsignedMutation(signer, mutation);
  return authorizeMutation(
    unsigned,
    signer.sign(getAuthorizationPayload(manifest, unsigned)),
  );
}

export function createAccount(
  manifest: TypewriterManifest<AssessmentMutations>,
  signer: Signer,
): Mutation<"CreateAccount"> {
  return authorize(manifest, signer, {
    name: "CreateAccount",
    params: { keyType: signer.keyType, publicKey: signer.publicKey },
    nonce: 0n,
  });
}

/** The nonce of step `index`. Each step has its own lane, so arrival order never decides a nonce check. */
export function stepNonce(index: number): bigint {
  return packNonce(BigInt(index + 1), 0n);
}

/**
 * Signs the mutation of `step`, submitted at `nowMs`. It expires
 * `expiresInS` after the second of `nowMs`, in the whole seconds of
 * `block.timestamp`. A negative `expiresInS` expires before genesis, so
 * before every block, and an infinite one never expires.
 */
export function signAtSubmission(
  manifest: TypewriterManifest<AssessmentMutations>,
  step: Step,
  nowMs: number,
): Mutation<AppMutationName> {
  const { name, params, authorization } = step.mutation;
  const expiration = !Number.isFinite(step.expiresInS)
    ? 0
    : step.expiresInS < 0
      ? SIM.chain.genesisTimestamp - 1
      : Math.floor(nowMs / 1000) + step.expiresInS;
  return authorize<AppMutationName>(manifest, step.signer, {
    name,
    params,
    nonce: authorization.nonce,
    expiration: BigInt(expiration),
  });
}

function below(random: Random.Random, length: number): number {
  return Math.floor(random.nextDoubleUnsafe() * length);
}

/** Draws the plan of `SIM.generator.mutations` steps. */
export function makePlan(
  signers: readonly Signer[],
  random: Random.Random,
): Step[] {
  const {
    mutations,
    delaysMs,
    revertRate,
    enqueueRate,
    resubmitRate,
    expirationsS,
  } = SIM.generator;
  return Array.from({ length: mutations }, (_, index): Step => {
    const delayMs = delaysMs[below(random, delaysMs.length)]!;
    const name: AppMutationName = random.nextDoubleUnsafe() < 0.5 ? "A" : "B";
    const via = random.nextDoubleUnsafe() < enqueueRate ? "enqueue" : "execute";
    const signer = signers[below(random, signers.length)]!;
    const params = {
      slot: BigInt(below(random, SLOT_COUNT)),
      value: BigInt(below(random, 1_000_000)),
      shouldRevert: random.nextDoubleUnsafe() < revertRate,
    };
    const resubmit =
      random.nextDoubleUnsafe() < resubmitRate && via === "execute";
    const expiresInS = expirationsS[below(random, expirationsS.length)]!;
    return {
      index,
      delayMs,
      via,
      resubmit,
      expiresInS,
      signer,
      mutation: unsigned(signer, { name, params, nonce: stepNonce(index) }),
    };
  });
}

/** Replays `order`, the steps that execute in execution order, as `Assessment.sol` executes them. */
export function replay(order: readonly Step[]): {
  accumulator: Hex.Hex;
  slots: Map<bigint, Hex.Hex>;
} {
  let accumulator: Hex.Hex = Hex.padLeft("0x0", 32);
  const slots = new Map<bigint, Hex.Hex>();

  for (const { mutation, signer } of order) {
    const { slot, value } = mutation.params;
    slots.set(
      slot,
      mutation.name === "A"
        ? Hex.fromNumber(value, { size: 32 })
        : Hash.keccak256(
            AbiParameters.encode(AbiParameters.from(["uint256"]), [value]),
          ),
    );
    accumulator = Hash.keccak256(
      AbiParameters.encode(
        AbiParameters.from([
          "bytes32",
          "uint8",
          "bytes32",
          "uint256",
          "uint256",
        ]),
        [
          accumulator,
          mutation.name === "A" ? 0 : 1,
          signer.accountID,
          slot,
          value,
        ],
      ),
    );
  }

  return { accumulator, slots };
}
