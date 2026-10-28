import type { Random } from "effect";
import { AbiFunction, Hex, TypedData } from "ox";
import type { Authorization } from "../src/client";
import type { TypewriterManifest } from "../src/config";
import {
  encodeAuthorizationCalldata,
  encodeMutationCalldata,
} from "../src/encoding";
import {
  AUTHORIZATION_EIP712_TYPES,
  BUILTIN_MUTATIONS,
  TYPEWRITER_ABI,
  TYPEWRITER_EIP712_DOMAIN,
} from "../src/typewriter-constants";
import type { AppMutationName, Signer, Step } from "./assessment";
import type { AssessmentMutations } from "./assessment-constants";

type Manifest = TypewriterManifest<AssessmentMutations>;

/**
 * What the runtime does with a malformed step. The contract decides it: an
 * enqueue is judged on the bytes the contract decodes and signs over, not on
 * what the runtime decodes them to.
 */
export type Outcome =
  /** It executes, since the contract executes it like the well-formed step. */
  | "executed"
  /** It is rejected, with one of the malformation's `errors`. */
  | "rejected"
  /** `execute` fails with `UnknownMutationError`, before any mutation event. */
  | "unknown"
  /**
   * It never executes and has no mutation event. The contract cannot decode
   * it, so no one can ever execute it.
   */
  | "ignored";

/** What the client submits for a malformed step. */
export type Submission =
  | {
      via: "execute";
      /** The input to `execute`, of any shape. */
      mutation: { name: unknown; params: unknown; authorization: unknown };
    }
  | {
      via: "enqueue";
      /** The arguments of `enqueue`. */
      mutation: number;
      mutationData: Hex.Hex;
      authorizationData: Hex.Hex;
      /** The authorization that `authorizationData` encodes, when it decodes. */
      authorization: Authorization;
    };

export type Malformation = {
  kind: string;
  via: "execute" | "enqueue";
  /** Either is right. A malformation never mixes ones with events and ones without. */
  outcomes: Outcome[];
  /** The errors of a rejection: a revert's error name, or an error's tag. */
  errors: string[];
  /** Builds the submission at submission time, when the step is signed. */
  build: (context: Context) => Submission;
};

export type Context = {
  manifest: Manifest;
  /** The signer of the step, whose account exists. */
  signer: Signer;
  /** A signer of the same key type with no account. */
  stranger: Signer;
  /** The well-formed mutation the step malforms, unsigned. */
  mutation: Step["mutation"];
};

/** The key of a submission's mutation events: its authorization's `accountID` and `nonce`. */
export function submissionAuthorization(submission: Submission): {
  accountID: Hex.Hex;
  nonce: bigint;
} {
  return (
    submission.via === "execute"
      ? submission.mutation.authorization
      : submission.authorization
  ) as { accountID: Hex.Hex; nonce: bigint };
}

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

/** A malformed signature: `abi.decode` reverts with no data, or it recovers another key. */
const BAD_SIGNATURE = ["InvalidSignature", "MutationRevertedError"];
const ENCODE = ["EncodeMutationError"];

const ENQUEUE_FUNCTION = AbiFunction.fromAbi(TYPEWRITER_ABI, "enqueue");

export function encodeEnqueue(
  submission: Extract<Submission, { via: "enqueue" }>,
): Hex.Hex {
  return AbiFunction.encodeData(ENQUEUE_FUNCTION, [
    submission.mutation,
    submission.mutationData,
    submission.authorizationData,
  ]);
}

function below(random: Random.Random, length: number): number {
  return Math.floor(random.nextDoubleUnsafe() * length);
}

function oneOf<const value>(
  random: Random.Random,
  values: readonly value[],
): value {
  return values[below(random, values.length)]!;
}

function randomBytes(random: Random.Random, size: number): Hex.Hex {
  return Hex.fromBytes(
    Uint8Array.from({ length: size }, () => below(random, 256)),
  );
}

/** The EIP-712 payload of an authorization over the bytes `mutationData`, as `_authorizationDigest` hashes it. */
function payload(
  manifest: Manifest,
  mutation: number,
  mutationData: Hex.Hex,
  authorization: Omit<Authorization, "signature">,
  chainId = manifest.chainId,
): Hex.Hex {
  return TypedData.getSignPayload({
    domain: {
      ...TYPEWRITER_EIP712_DOMAIN,
      chainId,
      verifyingContract: manifest.address,
    },
    types: AUTHORIZATION_EIP712_TYPES,
    primaryType: "Authorization",
    message: {
      accountID: authorization.accountID,
      credentialID: authorization.credentialID,
      nonce: authorization.nonce,
      // ox types `uint40` as a number.
      expiration: Number(authorization.expiration),
      mutation,
      mutationData,
    },
  });
}

type Signed = {
  name: string;
  params: unknown;
  id: number;
  mutationData: Hex.Hex;
  authorization: Authorization;
};

/**
 * The mutation of `context` with `change` applied, signed by `by`. `name`
 * must be a mutation of the manifest; `id` signs as another mutation ID.
 */
function sign(
  context: Context,
  change: Partial<
    { name: string; params: unknown; id: number; chainId: number } & Omit<
      Authorization,
      "signature"
    >
  > = {},
  by: Signer = context.signer,
): Signed {
  const { manifest, mutation } = context;
  const name = change.name ?? mutation.name;
  const params = change.params ?? mutation.params;
  const config = manifest.mutations[name as keyof AssessmentMutations];
  const fields = {
    accountID: change.accountID ?? mutation.authorization.accountID,
    credentialID: change.credentialID ?? mutation.authorization.credentialID,
    nonce: change.nonce ?? mutation.authorization.nonce,
    expiration: change.expiration ?? mutation.authorization.expiration,
  };
  const mutationData = encodeMutationCalldata({
    config,
    params,
    authorization: { ...fields, signature: "0x" },
  } as Parameters<typeof encodeMutationCalldata>[0]);
  const id = change.id ?? config.id;
  const signature = by.sign(
    payload(manifest, id, mutationData, fields, change.chainId),
  );
  return {
    name,
    params,
    id,
    mutationData,
    authorization: { ...fields, signature },
  };
}

function execute(
  signed: Pick<Signed, "name" | "params" | "authorization">,
  change: {
    name?: unknown;
    params?: unknown;
    authorization?: Record<string, unknown>;
  } = {},
): Submission {
  return {
    via: "execute",
    mutation: {
      name: "name" in change ? change.name : signed.name,
      params: "params" in change ? change.params : signed.params,
      authorization: { ...signed.authorization, ...change.authorization },
    },
  };
}

function enqueue(
  signed: Signed,
  change: Partial<
    Pick<
      Extract<Submission, { via: "enqueue" }>,
      "mutation" | "mutationData" | "authorizationData"
    >
  > = {},
): Submission {
  return {
    via: "enqueue",
    mutation: signed.id,
    mutationData: signed.mutationData,
    authorizationData: encodeAuthorizationCalldata(signed.authorization),
    authorization: signed.authorization,
    ...change,
  };
}

/** Replaces the 32-byte word at `index` of `data`. */
function setWord(data: Hex.Hex, index: number, word: Hex.Hex): Hex.Hex {
  const hex = data.slice(2);
  return `0x${hex.slice(0, index * 64)}${Hex.padLeft(word, 32).slice(2)}${hex.slice((index + 1) * 64)}`;
}

/** Sets the top byte of the word at `index`, above any type narrower than `uint256`. */
function dirtyWord(data: Hex.Hex, index: number): Hex.Hex {
  const word = data.slice(2 + index * 64, 2 + (index + 1) * 64);
  return setWord(data, index, `0xff${word.slice(2)}`);
}

/** The words of `encodeAuthorizationCalldata`: the tuple's offset, then its fields. */
const AUTHORIZATION_WORD = {
  offset: 0,
  credentialID: 2,
  expiration: 4,
} as const;

/** `encodeAuthorizationCalldata` up to the signature: the offset and the five head words. */
const AUTHORIZATION_HEAD_SIZE = 6 * 32;
/** `encodeMutationCalldata` of `A` and `B`: three static words. */
const PARAMS_SIZE = 3 * 32;

/**
 * Each draws the details of one malformed step. A malformed step draws one
 * uniformly, so every kind shows up, whatever the enqueue rate.
 */
const MALFORMATIONS: ((random: Random.Random) => Malformation)[] = [
  // `execute`: the mutation name.
  (random) => {
    const name = oneOf(random, ["C", "", "a", "createAccount"]);
    return {
      kind: "unknown name",
      via: "execute",
      outcomes: ["unknown"],
      errors: [],
      build: (context) => execute(sign(context), { name }),
    };
  },
  (random) => {
    const name = oneOf(random, [
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
      "valueOf",
    ]);
    return {
      kind: "Object.prototype name",
      via: "execute",
      outcomes: ["unknown"],
      errors: [],
      build: (context) => execute(sign(context), { name }),
    };
  },

  // `execute`: the params.
  (random) => {
    const field = oneOf(random, ["slot", "value", "shouldRevert"]);
    return {
      kind: `params missing ${field}`,
      via: "execute",
      outcomes: ["rejected"],
      errors: ENCODE,
      build: (context) => {
        const signed = sign(context);
        const { [field]: _, ...params } = context.mutation.params;
        return execute(signed, { params });
      },
    };
  },
  (random) => {
    const [field, value] = oneOf(random, [
      ["slot", "slot"],
      ["value", 1.5],
      ["value", {}],
      ["shouldRevert", "false"],
      ["shouldRevert", 0],
    ] as const);
    return {
      kind: `params ${field} of the wrong type`,
      via: "execute",
      outcomes: ["rejected"],
      errors: ENCODE,
      build: (context) =>
        execute(sign(context), {
          params: { ...context.mutation.params, [field]: value },
        }),
    };
  },
  (random) => {
    const field = oneOf(random, ["slot", "value"]);
    const value = oneOf(random, [-1n, MAX_UINT256 + 1n]);
    return {
      kind: `params ${field} out of range`,
      via: "execute",
      outcomes: ["rejected"],
      errors: ENCODE,
      build: (context) =>
        execute(sign(context), {
          params: { ...context.mutation.params, [field]: value },
        }),
    };
  },
  (random) => {
    const params = oneOf(random, [null, undefined, "params", 7]);
    return {
      kind: "params not an object",
      via: "execute",
      outcomes: ["rejected"],
      errors: ENCODE,
      build: (context) => execute(sign(context), { params }),
    };
  },
  // Values that encode to the same bytes, so the signature still holds.
  // Rejecting them is right too.
  (random) => {
    const shape = oneOf(random, ["numbers", "numeric strings", "array"]);
    return {
      kind: `params as ${shape}`,
      via: "execute",
      outcomes: ["executed", "rejected"],
      errors: ENCODE,
      build: (context) => {
        const { slot, value, shouldRevert } = context.mutation.params;
        return execute(sign(context), {
          params:
            shape === "numbers"
              ? { slot: Number(slot), value: Number(value), shouldRevert }
              : shape === "numeric strings"
                ? { slot: String(slot), value: String(value), shouldRevert }
                : [slot, value, shouldRevert],
        });
      },
    };
  },
  (random) => {
    const field = oneOf(random, [
      "extra",
      "execution_index",
      "authorization_nonce",
      "block_number",
    ]);
    return {
      kind: `params with an extra ${field}`,
      via: "execute",
      outcomes: ["executed"],
      errors: [],
      build: (context) =>
        execute(sign(context), {
          params: { ...context.mutation.params, [field]: 123n },
        }),
    };
  },

  // `execute`: the authorization.
  (random) => {
    const accountID = randomBytes(random, 32);
    return {
      kind: "unknown account",
      via: "execute",
      outcomes: ["rejected"],
      errors: ["AccountNotFound"],
      build: (context) => execute(sign(context, { accountID })),
    };
  },
  (random) => {
    const accountID = oneOf(random, [
      "0x1234",
      randomBytes(random, 31),
      randomBytes(random, 33),
      "account",
    ]);
    return {
      kind: "accountID not 32 bytes",
      via: "execute",
      outcomes: ["rejected"],
      errors: ENCODE,
      build: (context) =>
        execute(sign(context), { authorization: { accountID } }),
    };
  },
  (random) => {
    const credentialID = oneOf(random, [1n, 2n, 1n << 63n, MAX_UINT64]);
    return {
      kind: "unknown credential",
      via: "execute",
      outcomes: ["rejected"],
      errors: ["CredentialNotFound"],
      build: (context) => execute(sign(context, { credentialID })),
    };
  },
  (random) => {
    const credentialID = oneOf(random, [-1n, MAX_UINT64 + 1n]);
    return {
      kind: "credentialID out of range",
      via: "execute",
      outcomes: ["rejected"],
      errors: ENCODE,
      build: (context) =>
        execute(sign(context), { authorization: { credentialID } }),
    };
  },
  (random) => {
    const sequence = BigInt(1 + below(random, 3));
    return {
      kind: "nonce out of sequence",
      via: "execute",
      outcomes: ["rejected"],
      errors: ["InvalidNonce"],
      build: (context) =>
        execute(
          sign(context, {
            nonce: context.mutation.authorization.nonce + sequence,
          }),
        ),
    };
  },
  () => ({
    kind: "nonce at the last sequence",
    via: "execute",
    outcomes: ["rejected"],
    errors: ["NonceOverflow"],
    build: (context) =>
      execute(
        sign(context, {
          nonce: context.mutation.authorization.nonce | MAX_UINT64,
        }),
      ),
  }),
  (random) => {
    const negative = random.nextDoubleUnsafe() < 0.5;
    return {
      kind: "nonce out of range",
      via: "execute",
      outcomes: ["rejected"],
      errors: ENCODE,
      build: (context) => {
        const { nonce } = context.mutation.authorization;
        return execute(sign(context), {
          authorization: { nonce: negative ? -nonce : nonce + (1n << 256n) },
        });
      },
    };
  },
  (random) => {
    const expiration = oneOf(random, [-1n, 1n << 40n]);
    return {
      kind: "expiration out of range",
      via: "execute",
      outcomes: ["rejected"],
      errors: ENCODE,
      build: (context) =>
        execute(sign(context), { authorization: { expiration } }),
    };
  },
  (random) => {
    const field = oneOf(random, [
      "accountID",
      "credentialID",
      "nonce",
      "expiration",
    ]);
    return {
      kind: `authorization ${field} of the wrong type`,
      via: "execute",
      outcomes: ["rejected"],
      errors: ENCODE,
      build: (context) => {
        const { authorization } = context.mutation;
        // Unique per step, so the events keep their own key.
        const value =
          field === "accountID"
            ? 7
            : field === "nonce"
              ? `${authorization.nonce}n`
              : "never";
        return execute(sign(context), { authorization: { [field]: value } });
      },
    };
  },
  (random) => {
    const field = oneOf(random, ["credentialID", "expiration", "signature"]);
    return {
      kind: `authorization missing ${field}`,
      via: "execute",
      outcomes: ["rejected"],
      errors: ENCODE,
      build: (context) => {
        const { [field]: _, ...authorization } = sign(context).authorization;
        return {
          via: "execute",
          mutation: {
            name: context.mutation.name,
            params: context.mutation.params,
            authorization,
          },
        };
      },
    };
  },
  (random) => {
    const how = oneOf(random, [
      "by another key",
      "over other params",
      "as the other mutation",
      "for another chain",
      "empty",
      "truncated",
      "garbage",
    ]);
    const cut = 32 + below(random, 33);
    const garbage = random.nextDoubleUnsafe();
    return {
      kind: `signature ${how}`,
      via: "execute",
      outcomes: ["rejected"],
      errors: BAD_SIGNATURE,
      build: (context) => {
        const signed = sign(context);
        const { signature } = signed.authorization;
        const other: AppMutationName =
          context.mutation.name === "A" ? "B" : "A";
        switch (how) {
          case "by another key":
            return execute(sign(context, {}, context.stranger));
          case "over other params":
            return execute(signed, {
              params: {
                ...context.mutation.params,
                value: context.mutation.params.value + 1n,
              },
            });
          case "as the other mutation":
            return execute(signed, { name: other });
          case "for another chain":
            return execute(
              sign(context, { chainId: context.manifest.chainId + 1 }),
            );
          case "empty":
            return execute(signed, { authorization: { signature: "0x" } });
          case "truncated":
            return execute(signed, {
              authorization: {
                signature: Hex.slice(signature, 0, Hex.size(signature) - cut),
              },
            });
          case "garbage":
            return execute(signed, {
              authorization: {
                signature: Hex.fromBytes(
                  Uint8Array.from(
                    { length: Hex.size(signature) },
                    (_, i) => (i * 131 + Math.floor(garbage * 256)) % 256,
                  ),
                ),
              },
            });
        }
      },
    };
  },
  (random) => {
    const how = oneOf(random, [
      "not hex",
      "with a non-hex character",
      "of odd length",
      "with a 0X prefix",
    ]);
    return {
      kind: `signature ${how}`,
      via: "execute",
      outcomes: ["rejected"],
      errors: ENCODE,
      build: (context) => {
        const signed = sign(context);
        const { signature } = signed.authorization;
        return execute(signed, {
          authorization: {
            signature:
              how === "not hex"
                ? "signature"
                : how === "with a non-hex character"
                  ? `${signature}zz`
                  : how === "of odd length"
                    ? `${signature}0`
                    : `0X${signature.slice(2)}`,
          },
        });
      },
    };
  },

  // `execute`: the built-in mutations, signed, with params the contract rejects.
  (random) => {
    const how = oneOf(random, [
      "AddCredential with an empty public key",
      "AddCredential with an unknown key type",
      "RemoveCredential of the last credential",
      "RemoveCredential of an unknown credential",
      "CreateAccount with a nonce",
    ]);
    return {
      kind: how,
      via: "execute",
      outcomes: ["rejected"],
      errors: {
        "AddCredential with an empty public key": ["EmptyPublicKey"],
        // `abi.decode` reverts on an enum out of range.
        "AddCredential with an unknown key type": [
          "Panic",
          "MutationRevertedError",
        ],
        "RemoveCredential of the last credential": ["LastCredential"],
        "RemoveCredential of an unknown credential": ["CredentialNotFound"],
        "CreateAccount with a nonce": ["InvalidCreateAuthorization"],
      }[how],
      build: (context) => execute(sign(context, builtin(context, how))),
    };
  },

  // `enqueue`: bytes the contract cannot decode, so no one can execute.
  (random) => {
    const id = 2 + below(random, BUILTIN_MUTATIONS.CreateAccount.id - 2);
    return {
      kind: `unknown mutation ID ${id}`,
      via: "enqueue",
      outcomes: ["ignored"],
      errors: [],
      build: (context) => enqueue(sign(context, { id })),
    };
  },
  (random) => {
    const size = below(random, PARAMS_SIZE);
    return {
      kind: "mutationData truncated",
      via: "enqueue",
      outcomes: ["ignored"],
      errors: [],
      build: (context) => {
        const signed = sign(context);
        return enqueue(signed, {
          mutationData: Hex.slice(signed.mutationData, 0, size),
        });
      },
    };
  },
  (random) => {
    const value = BigInt(2 + below(random, 254));
    return {
      kind: "mutationData with an invalid bool",
      via: "enqueue",
      outcomes: ["ignored"],
      errors: [],
      build: (context) => {
        const signed = sign(context);
        return enqueue(signed, {
          mutationData: setWord(
            signed.mutationData,
            2,
            Hex.fromNumber(value, { size: 32 }),
          ),
        });
      },
    };
  },
  (random) => {
    const size = below(random, AUTHORIZATION_HEAD_SIZE);
    return {
      kind: "authorizationData truncated",
      via: "enqueue",
      outcomes: ["ignored"],
      errors: [],
      build: (context) => {
        const signed = sign(context);
        return enqueue(signed, {
          authorizationData: Hex.slice(
            encodeAuthorizationCalldata(signed.authorization),
            0,
            size,
          ),
        });
      },
    };
  },
  (random) => {
    const offset = oneOf(random, [0x1000n, 1n << 255n, MAX_UINT256]);
    return {
      kind: "authorizationData with an offset out of bounds",
      via: "enqueue",
      outcomes: ["ignored"],
      errors: [],
      build: (context) => {
        const signed = sign(context);
        return enqueue(signed, {
          authorizationData: setWord(
            encodeAuthorizationCalldata(signed.authorization),
            AUTHORIZATION_WORD.offset,
            Hex.fromNumber(offset, { size: 32 }),
          ),
        });
      },
    };
  },
  (random) => {
    const field = oneOf(random, ["credentialID", "expiration"] as const);
    return {
      kind: `authorizationData with dirty high bits in ${field}`,
      via: "enqueue",
      outcomes: ["ignored"],
      errors: [],
      build: (context) => {
        const signed = sign(context);
        return enqueue(signed, {
          authorizationData: dirtyWord(
            encodeAuthorizationCalldata(signed.authorization),
            AUTHORIZATION_WORD[field],
          ),
        });
      },
    };
  },

  // `enqueue`: bytes the contract decodes to the well-formed mutation.
  (random) => {
    const trailing = randomBytes(random, 1 + below(random, 64));
    const signedOver = oneOf(random, ["canonical", "sent"] as const);
    return {
      kind: `mutationData with trailing bytes, signed over the ${signedOver} bytes`,
      via: "enqueue",
      // The signature covers the bytes the contract got.
      outcomes: signedOver === "sent" ? ["executed"] : ["rejected"],
      errors: signedOver === "sent" ? [] : ["InvalidSignature"],
      build: (context) => {
        const signed = sign(context);
        const mutationData = Hex.concat(signed.mutationData, trailing);
        if (signedOver === "canonical") {
          return enqueue(signed, { mutationData });
        }
        const { signature: _, ...fields } = signed.authorization;
        const signature = context.signer.sign(
          payload(context.manifest, signed.id, mutationData, fields),
        );
        return enqueue(
          { ...signed, authorization: { ...fields, signature } },
          { mutationData },
        );
      },
    };
  },
  (random) => {
    const trailing = randomBytes(random, 1 + below(random, 64));
    return {
      kind: "authorizationData with trailing bytes",
      via: "enqueue",
      outcomes: ["executed"],
      errors: [],
      build: (context) => {
        const signed = sign(context);
        return enqueue(signed, {
          authorizationData: Hex.concat(
            encodeAuthorizationCalldata(signed.authorization),
            trailing,
          ),
        });
      },
    };
  },
  (random) => {
    const gap = randomBytes(random, 32);
    return {
      kind: "authorizationData with a gap before the tuple",
      via: "enqueue",
      outcomes: ["executed"],
      errors: [],
      build: (context) => {
        const signed = sign(context);
        const data = encodeAuthorizationCalldata(signed.authorization);
        return enqueue(signed, {
          authorizationData: Hex.concat(
            Hex.fromNumber(0x40, { size: 32 }),
            gap,
            Hex.slice(data, 32),
          ),
        });
      },
    };
  },

  // `enqueue`: well-encoded, with an authorization the contract rejects.
  (random) => {
    const how = oneOf(random, [
      "under the other mutation ID",
      "by another key",
      "with a garbage signature",
      "for an unknown account",
      "with a nonce out of sequence",
      "for an unknown credential",
      "RemoveCredential of the last credential",
    ]);
    const accountID = randomBytes(random, 32);
    return {
      kind: `enqueue ${how}`,
      via: "enqueue",
      outcomes: ["rejected"],
      errors: {
        "under the other mutation ID": ["InvalidSignature"],
        "by another key": ["InvalidSignature"],
        "with a garbage signature": BAD_SIGNATURE,
        "for an unknown account": ["AccountNotFound"],
        "with a nonce out of sequence": ["InvalidNonce"],
        "for an unknown credential": ["CredentialNotFound"],
        "RemoveCredential of the last credential": ["LastCredential"],
      }[how],
      build: (context) => {
        const { nonce } = context.mutation.authorization;
        switch (how) {
          case "under the other mutation ID": {
            const signed = sign(context);
            return enqueue(signed, { mutation: signed.id === 0 ? 1 : 0 });
          }
          case "by another key":
            return enqueue(sign(context, {}, context.stranger));
          case "with a garbage signature": {
            const signed = sign(context);
            return enqueue({
              ...signed,
              authorization: {
                ...signed.authorization,
                signature: Hex.padLeft("0x01", 96),
              },
            });
          }
          case "for an unknown account":
            return enqueue(sign(context, { accountID }));
          case "with a nonce out of sequence":
            return enqueue(sign(context, { nonce: nonce + 1n }));
          case "for an unknown credential":
            return enqueue(sign(context, { credentialID: 1n }));
          case "RemoveCredential of the last credential":
            return enqueue(sign(context, builtin(context, how)));
        }
      },
    };
  },
];

/** The name and params of a built-in mutation that the contract rejects. */
function builtin(
  context: Context,
  how: string,
): { name: string; params: unknown } {
  const { keyType, publicKey } = context.signer;
  switch (how) {
    case "AddCredential with an empty public key":
      return {
        name: "AddCredential",
        params: {
          expiration: 0n,
          keyType,
          permissions: MAX_UINT256,
          publicKey: "0x",
        },
      };
    case "AddCredential with an unknown key type":
      return {
        name: "AddCredential",
        params: { expiration: 0n, keyType: 7, permissions: 1n, publicKey },
      };
    case "RemoveCredential of the last credential":
      return { name: "RemoveCredential", params: { credentialID: 0n } };
    case "RemoveCredential of an unknown credential":
      return { name: "RemoveCredential", params: { credentialID: 7n } };
    default:
      // The step's nonce is never 0, so the contract rejects it.
      return { name: "CreateAccount", params: { keyType, publicKey } };
  }
}

/** Draws a malformation, uniformly over the kinds. */
export function drawMalformation(random: Random.Random): Malformation {
  return MALFORMATIONS[below(random, MALFORMATIONS.length)]!(random);
}
