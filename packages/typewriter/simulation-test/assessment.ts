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
import {
  drawMalformation,
  expectMalformed,
  type Malformation,
} from "./malformations";
import type { Expected } from "./run";
import { TEMPLATES, type Template } from "./templates";

/** The mutations of `Assessment.sol`, without the built-in ones. */
export type AppMutationName = "A" | "B" | "C";

export type Manifest = TypewriterManifest<AssessmentMutations>;

export type Mutation<
  name extends keyof AssessmentMutations & string = keyof AssessmentMutations &
    string,
> = AuthorizedMutation<Manifest, name>;

/** One entry of the plan. */
export type Step = {
  index: number;
  delayMs: number;
  via: "execute" | "enqueue";
  /** Executes the mutation again as soon as it is received. The second `execute` fails. */
  resubmit: boolean;
  /** Drawn from `SIM.generator.expirationsS`. See {@link withExpiration}. */
  expiresInS: number;
  signer: Signer;
  /** Unsigned, with a `0x` signature, until it is submitted. */
  mutation: Mutation<AppMutationName>;
  /** Submits a malformed version of `mutation` instead. */
  malformation: Malformation | undefined;
};

export function stepLabel({
  index,
  via,
  mutation,
  malformation,
}: Step): string {
  return malformation === undefined
    ? `step ${index} (${via} ${mutation.name})`
    : `step ${index} (${via} ${mutation.name}, ${malformation.name})`;
}

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
    const args = AbiParameters.encode(AbiParameters.from(["address"]), [
      deployer,
    ]);
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

function unsigned<const name extends keyof AssessmentMutations & string>(
  signer: Signer,
  mutation: Pick<Mutation<name>, "name" | "params"> & { nonce: bigint },
): Mutation<name> {
  return authorizeMutation(
    {
      ...mutation,
      accountID: signer.accountID,
      credentialID: 0n,
      expiration: 0n,
    },
    "0x",
  );
}

export function createAccount(manifest: Manifest, signer: Signer) {
  const mutation = unsigned(signer, {
    name: "CreateAccount",
    params: { keyType: signer.keyType, publicKey: signer.publicKey },
    nonce: 0n,
  });
  return authorizeMutation(
    { ...mutation, ...mutation.authorization },
    signer.sign(
      getAuthorizationPayload(manifest, {
        ...mutation,
        ...mutation.authorization,
      }),
    ),
  );
}

/** The nonce of step `index`. Each step has its own lane, so arrival order never decides a nonce check. */
export function stepNonce(index: number): bigint {
  return packNonce(BigInt(index + 1), 0n);
}

/**
 * The mutation of `step`, submitted at `nowMs`, with its expiration. It
 * expires `expiresInS` after the second of `nowMs`, in the whole seconds of
 * `block.timestamp`. A negative `expiresInS` expires before genesis, so
 * before every block, and an infinite one never expires.
 */
export function withExpiration(
  step: Step,
  nowMs: number,
): Mutation<AppMutationName> {
  const { expiresInS, mutation } = step;
  const expiration = !Number.isFinite(expiresInS)
    ? 0
    : expiresInS < 0
      ? SIM.chain.genesisTimestamp - 1
      : Math.floor(nowMs / 1000) + expiresInS;
  return {
    ...mutation,
    authorization: {
      ...mutation.authorization,
      expiration: BigInt(expiration),
    },
  };
}

/** How `step` must end. */
export function expect(step: Step): Expected {
  const expected = expectExecute(step);
  // The runtime never decodes an enqueue, so it has no events.
  return step.via === "enqueue" ? { ...expected, events: false } : expected;
}

function expectExecute(step: Step): Expected {
  const { mutation, malformation, expiresInS, via } = step;
  if (malformation !== undefined) return expectMalformed(malformation);
  // The runtime rejects an `execute` that expires within its margin before
  // it executes. An enqueue is already onchain, so only revm rejects it.
  const tooSoon = via === "execute" ? "MutationExpiresTooSoonError" : undefined;
  if (expiresInS < 0) {
    const errors = [tooSoon ?? "AuthorizationExpired"];
    return {
      executes: false,
      errors,
      resubmissionErrors: errors,
      events: true,
    };
  }
  // A finite authorization can be rejected within the margin, or expire
  // after it is accepted, before the runtime simulates its settlement.
  const expired = Number.isFinite(expiresInS)
    ? ["AuthorizationExpired", ...(tooSoon === undefined ? [] : [tooSoon])]
    : [];
  const revert = `${mutation.name}Error`;
  return mutation.params.shouldRevert
    ? {
        executes: false,
        errors: [revert, ...expired],
        resubmissionErrors: [revert, ...expired],
        events: true,
      }
    : {
        executes: true,
        errors: expired,
        // The first submission used the nonce.
        resubmissionErrors: ["InvalidNonce", ...expired],
        events: true,
      };
}

function below(random: Random.Random, length: number): number {
  return Math.floor(random.nextDoubleUnsafe() * length);
}

/** The well-formed mutation of `template`, unsigned. */
function fromTemplate(
  signer: Signer,
  template: Template,
  shouldRevert: boolean,
  index: number,
): Mutation<AppMutationName> {
  return unsigned<AppMutationName>(signer, {
    name: template.name,
    params: { ...template.params, shouldRevert },
    nonce: stepNonce(index),
  } as Pick<Mutation<AppMutationName>, "name" | "params"> & { nonce: bigint });
}

/** Draws the plan of `SIM.generator.mutations` steps from {@link TEMPLATES}. */
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
    malformedRate,
  } = SIM.generator;
  const plan = Array.from({ length: mutations }, (_, index): Step => {
    const delayMs = delaysMs[below(random, delaysMs.length)]!;
    const signer = signers[below(random, signers.length)]!;
    const template = TEMPLATES[below(random, TEMPLATES.length)]!;
    if (random.nextDoubleUnsafe() < malformedRate) {
      // A malformation decides how its step is submitted and how it ends, so
      // the mutation it starts from neither reverts nor expires.
      const malformation = drawMalformation(random, template.name);
      return {
        index,
        delayMs,
        via: malformation.via,
        resubmit: false,
        expiresInS: Infinity,
        signer,
        mutation: fromTemplate(signer, template, false, index),
        malformation,
      };
    }
    const shouldRevert = random.nextDoubleUnsafe() < revertRate;
    const via = random.nextDoubleUnsafe() < enqueueRate ? "enqueue" : "execute";
    return {
      index,
      delayMs,
      via,
      resubmit: via === "execute" && random.nextDoubleUnsafe() < resubmitRate,
      expiresInS: expirationsS[below(random, expirationsS.length)]!,
      signer,
      mutation: fromTemplate(signer, template, shouldRevert, index),
      malformation: undefined,
    };
  });

  // A malformed enqueue may have no mutation event, so nothing shows the
  // runtime read its log. A well-formed enqueue after it executes onchain:
  // the runtime force-executes enqueues in queue order.
  if (plan.some((step) => step.malformation?.via === "enqueue")) {
    const index = plan.length;
    const signer = signers[below(random, signers.length)]!;
    plan.push({
      index,
      delayMs: 0,
      via: "enqueue",
      resubmit: false,
      expiresInS: Infinity,
      signer,
      mutation: fromTemplate(signer, TEMPLATES[0]!, false, index),
      malformation: undefined,
    });
  }
  return plan;
}
