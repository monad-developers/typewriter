import type { Random } from "effect";
import { AbiFunction, Hex, TypedData } from "ox";
import type { Authorization } from "../src/client";
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
import type {
  AppMutationName,
  Manifest,
  Mutation,
  Signer,
  Step,
} from "./assessment";
import type { AssessmentMutations } from "./assessment-constants";
import { type Expected, mutationKey } from "./run";

/**
 * A way to malform a mutation. It changes the mutation at up to three points
 * of its submission: what gets signed, the `execute` input after signing, and
 * the `enqueue` bytes after encoding.
 */
export type Malformation = {
  name: string;
  via: "execute" | "enqueue";
  /** The mutations it applies to. All of them when unset. */
  appliesTo?: AppMutationName[];
  /**
   * How the runtime must end it: executed, since the contract executes it
   * like the well-formed one; rejected with one of the errors; failed with
   * `UnknownMutationError`; or ignored, with no event, since the contract
   * cannot decode it and no one can execute it.
   */
  expect: "executed" | "unknown" | "ignored" | { rejected: string[] };
  signing?: (context: Context) => Signing;
  input?: (input: Input, context: Context) => Input;
  bytes?: (args: EnqueueArgs, context: Context) => EnqueueArgs;
};

export type Context = {
  manifest: Manifest;
  signer: Signer;
  /** A signer of the same key type with no account. */
  stranger: Signer;
  /** The step's well-formed mutation, unsigned, with its expiration. */
  mutation: Mutation<AppMutationName>;
  /** The step's own stream, for sizes and choices. */
  random: Random.Random;
};

/** What a signature covers and who signs it. Unset fields are the mutation's own. */
type Signing = {
  /** Signs as this mutation, with `params`. */
  name?: keyof AssessmentMutations & string;
  params?: unknown;
  /** Signs as this mutation ID instead of the name's. */
  id?: number;
  accountID?: Hex.Hex;
  credentialID?: bigint;
  nonce?: bigint;
  chainId?: number;
  by?: Signer;
};

/** The input of `execute`. Once malformed, any field can have any shape. */
type Input = {
  name: unknown;
  params: unknown;
  authorization: Partial<Authorization> & Record<string, unknown>;
};

/** The arguments of `enqueue`. */
type EnqueueArgs = {
  mutation: number;
  mutationData: Hex.Hex;
  authorizationData: Hex.Hex;
};

/** A step ready to submit. */
export type Prepared = {
  /** The well-formed mutation, signed: what executes if anything does. */
  mutation: Mutation;
  /** The key of the step's mutation events. */
  key: string;
  sent:
    | { via: "execute"; input: Input }
    | { via: "enqueue"; calldata: Hex.Hex };
};

/** Signs the mutation of `step`, then malforms it if the step says so. */
export function prepare(step: Step, context: Context): Prepared {
  const { malformation } = step;
  const signed = sign(context, malformation?.signing?.(context));
  const { mutation } = signed;

  if (step.via === "execute") {
    const wellFormed = {
      name: mutation.name,
      params: mutation.params,
      authorization: mutation.authorization,
    };
    const input = malformation?.input?.(wellFormed, context) ?? wellFormed;
    return {
      mutation,
      key: mutationKey(input.authorization as Authorization),
      sent: { via: "execute", input },
    };
  }

  const wellFormed = {
    mutation: signed.id,
    mutationData: signed.mutationData,
    authorizationData: encodeAuthorizationCalldata(mutation.authorization),
  };
  const args = malformation?.bytes?.(wellFormed, context) ?? wellFormed;
  return {
    mutation,
    key: mutationKey(mutation.authorization),
    sent: {
      via: "enqueue",
      calldata: AbiFunction.encodeData(ENQUEUE, [
        args.mutation,
        args.mutationData,
        args.authorizationData,
      ]),
    },
  };
}

export function expectMalformed({ expect }: Malformation): Expected {
  switch (expect) {
    case "executed":
      return {
        executes: true,
        errors: [],
        resubmissionErrors: [],
        events: true,
      };
    case "unknown":
      return {
        executes: false,
        errors: ["UnknownMutationError"],
        resubmissionErrors: [],
        events: false,
      };
    case "ignored":
      return {
        executes: false,
        errors: [],
        resubmissionErrors: [],
        events: false,
      };
    default:
      return {
        executes: false,
        errors: expect.rejected,
        resubmissionErrors: [],
        events: true,
      };
  }
}

/** Draws one of the malformations that apply to the mutation `name`. */
export function drawMalformation(
  random: Random.Random,
  name: AppMutationName,
): Malformation {
  const candidates = MALFORMATIONS.filter(
    (malformation) => malformation.appliesTo?.includes(name) ?? true,
  );
  return candidates[below(random, candidates.length)]!;
}

const ENQUEUE = AbiFunction.fromAbi(TYPEWRITER_ABI, "enqueue");

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

const rejected = (...errors: string[]) => ({ rejected: errors });
const ENCODE = rejected("EncodeMutationError");
/** `abi.decode` of a malformed signature reverts with no data, or the signature recovers another key. */
const BAD_SIGNATURE = rejected("InvalidSignature", "MutationRevertedError");

/** The mutations with the same params as another, so their encodings swap. */
const TWINS: Record<string, AppMutationName> = { A: "B", B: "A" };

/**
 * Every way the harness malforms a mutation. A malformed step draws one of
 * those that apply to its mutation.
 */
export const MALFORMATIONS: Malformation[] = [
  // `execute`: the name.
  ...["F", "", "a", "createAccount"].map(
    (name): Malformation => ({
      name: `name ${JSON.stringify(name)}`,
      via: "execute",
      expect: "unknown",
      input: (input) => ({ ...input, name }),
    }),
  ),
  ...["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"].map(
    (name): Malformation => ({
      name: `Object.prototype name ${name}`,
      via: "execute",
      expect: "unknown",
      input: (input) => ({ ...input, name }),
    }),
  ),

  // `execute`: the params.
  {
    name: "params missing a field",
    via: "execute",
    expect: ENCODE,
    input: (input, context) => {
      const { [pickParam(context).name]: _, ...params } = paramsOf(input);
      return { ...input, params };
    },
  },
  {
    name: "params field of the wrong type",
    via: "execute",
    expect: ENCODE,
    input: (input, context) => {
      const param = pickParam(context);
      return withParam(input, param.name, wrongType(param.type));
    },
  },
  {
    name: "params integer out of range",
    via: "execute",
    expect: ENCODE,
    input: (input, context) => {
      const param = pickParam(context, (type) => bitsOf(type) !== undefined);
      return withParam(input, param.name, outOfRange(param.type, context));
    },
  },
  ...[null, undefined, "params", 7].map(
    (params): Malformation => ({
      name: `params ${JSON.stringify(params) ?? "undefined"}`,
      via: "execute",
      expect: ENCODE,
      input: (input) => ({ ...input, params }),
    }),
  ),
  // Values that encode to the same bytes, so the signature still holds.
  {
    name: "params integers as strings",
    via: "execute",
    expect: "executed",
    input: (input) => ({
      ...input,
      params: mapIntegers(paramsOf(input), (value) => String(value)),
    }),
  },
  {
    name: "params small integers as numbers",
    via: "execute",
    expect: "executed",
    input: (input) => ({
      ...input,
      params: mapIntegers(paramsOf(input), (value) =>
        Number.isSafeInteger(Number(value)) ? Number(value) : value,
      ),
    }),
  },
  {
    name: "params as a positional array",
    via: "execute",
    expect: "executed",
    input: (input, context) => ({
      ...input,
      params: configOf(context).params.map(
        (param) => paramsOf(input)[param.name],
      ),
    }),
  },
  ...["extra", "execution_index", "authorization_nonce", "block_number"].map(
    (field): Malformation => ({
      name: `params with an extra ${field}`,
      via: "execute",
      expect: "executed",
      input: (input) => withParam(input, field, 123n),
    }),
  ),

  // `execute`: the authorization, after signing.
  ...[
    ["accountID", "0x1234"],
    ["accountID", `0x${"11".repeat(31)}`],
    ["accountID", `0x${"11".repeat(33)}`],
    ["accountID", "account"],
    ["credentialID", -1n],
    ["credentialID", MAX_UINT64 + 1n],
    ["expiration", -1n],
    ["expiration", 1n << 40n],
    ["credentialID", "zero"],
    ["expiration", "never"],
  ].map(
    ([field, value]): Malformation => ({
      name: `authorization ${field} ${String(value)}`,
      via: "execute",
      expect: ENCODE,
      input: (input) => withAuthorization(input, field as string, value),
    }),
  ),
  // The nonce stays unique to the step, so the step keeps its own events.
  {
    name: "authorization nonce negative",
    via: "execute",
    expect: ENCODE,
    input: (input) =>
      withAuthorization(input, "nonce", -(input.authorization.nonce as bigint)),
  },
  {
    name: "authorization nonce above uint256",
    via: "execute",
    expect: ENCODE,
    input: (input) =>
      withAuthorization(
        input,
        "nonce",
        (input.authorization.nonce as bigint) + (1n << 256n),
      ),
  },
  {
    name: "authorization nonce as a string",
    via: "execute",
    expect: ENCODE,
    input: (input) =>
      withAuthorization(input, "nonce", `${input.authorization.nonce}n`),
  },
  ...["credentialID", "expiration", "signature"].map(
    (field): Malformation => ({
      name: `authorization missing ${field}`,
      via: "execute",
      expect: ENCODE,
      input: (input) => {
        const { [field]: _, ...authorization } = input.authorization;
        return { ...input, authorization };
      },
    }),
  ),
  {
    name: "signature empty",
    via: "execute",
    expect: BAD_SIGNATURE,
    input: (input) => withAuthorization(input, "signature", "0x"),
  },
  {
    // A cut of a word or more always reaches past the padding.
    name: "signature truncated",
    via: "execute",
    expect: BAD_SIGNATURE,
    input: (input, context) => {
      const signature = input.authorization.signature as Hex.Hex;
      const cut = 32 + below(context.random, 33);
      return withAuthorization(
        input,
        "signature",
        Hex.slice(signature, 0, Math.max(0, Hex.size(signature) - cut)),
      );
    },
  },
  {
    name: "signature garbage",
    via: "execute",
    expect: BAD_SIGNATURE,
    input: (input, context) => {
      const signature = input.authorization.signature as Hex.Hex;
      return withAuthorization(
        input,
        "signature",
        randomBytes(context.random, Hex.size(signature)),
      );
    },
  },
  ...(
    [
      ["not hex", () => "signature"],
      ["with a non-hex character", (signature) => `${signature}zz`],
      ["of odd length", (signature) => `${signature}0`],
      ["with a 0X prefix", (signature) => `0X${signature.slice(2)}`],
    ] as [string, (signature: Hex.Hex) => string][]
  ).map(
    ([how, malform]): Malformation => ({
      name: `signature ${how}`,
      via: "execute",
      expect: ENCODE,
      input: (input) =>
        withAuthorization(
          input,
          "signature",
          malform(input.authorization.signature as Hex.Hex),
        ),
    }),
  ),

  // `execute`: what gets signed.
  {
    name: "unknown account",
    via: "execute",
    expect: rejected("AccountNotFound"),
    signing: (context) => ({ accountID: randomBytes(context.random, 32) }),
  },
  ...[1n, 1n << 63n, MAX_UINT64].map(
    (credentialID): Malformation => ({
      name: `unknown credential ${credentialID}`,
      via: "execute",
      expect: rejected("CredentialNotFound"),
      signing: () => ({ credentialID }),
    }),
  ),
  {
    name: "nonce out of sequence",
    via: "execute",
    expect: rejected("InvalidNonce"),
    signing: (context) => ({ nonce: nonceOf(context) + 1n }),
  },
  {
    name: "nonce at the last sequence",
    via: "execute",
    expect: rejected("NonceOverflow"),
    signing: (context) => ({ nonce: nonceOf(context) | MAX_UINT64 }),
  },
  {
    name: "signed by another key",
    via: "execute",
    expect: rejected("InvalidSignature"),
    signing: (context) => ({ by: context.stranger }),
  },
  {
    name: "signed for another chain",
    via: "execute",
    expect: rejected("InvalidSignature"),
    signing: (context) => ({ chainId: context.manifest.chainId + 1 }),
  },
  {
    name: "signed over other params",
    via: "execute",
    expect: rejected("InvalidSignature"),
    signing: (context) => ({
      params: {
        ...context.mutation.params,
        slot: context.mutation.params.slot + 1n,
      },
    }),
    input: (input, context) => ({ ...input, params: context.mutation.params }),
  },
  {
    name: "signed as its twin mutation",
    via: "execute",
    appliesTo: ["A", "B"],
    expect: rejected("InvalidSignature"),
    signing: (context) => ({
      id: idOf(context, TWINS[context.mutation.name]!),
    }),
  },

  // `execute`: built-in mutations with params the contract rejects.
  ...(
    [
      [
        "AddCredential with an empty public key",
        "EmptyPublicKey",
        (signer) => ({
          name: "AddCredential",
          params: {
            expiration: 0,
            keyType: signer.keyType,
            permissions: MAX_UINT256,
            publicKey: "0x",
          },
        }),
      ],
      [
        // `abi.decode` reverts on an enum out of range.
        "AddCredential with an unknown key type",
        "MutationRevertedError",
        (signer) => ({
          name: "AddCredential",
          params: {
            expiration: 0,
            keyType: 7,
            permissions: 1n,
            publicKey: signer.publicKey,
          },
        }),
      ],
      [
        "RemoveCredential of the last credential",
        "LastCredential",
        () => ({ name: "RemoveCredential", params: { credentialID: 0n } }),
      ],
      [
        "RemoveCredential of an unknown credential",
        "CredentialNotFound",
        () => ({ name: "RemoveCredential", params: { credentialID: 7n } }),
      ],
      [
        // The step's nonce is never 0.
        "CreateAccount with a nonce",
        "InvalidCreateAuthorization",
        (signer) => ({
          name: "CreateAccount",
          params: { keyType: signer.keyType, publicKey: signer.publicKey },
        }),
      ],
    ] as [string, string, (signer: Signer) => Signing][]
  ).flatMap(([name, error, signing]): Malformation[] =>
    (["execute", "enqueue"] as const).map((via) => ({
      name,
      via,
      expect: rejected(
        error,
        ...(error === "MutationRevertedError" ? ["Panic"] : []),
      ),
      signing: (context) => signing(context.signer),
    })),
  ),

  // `enqueue`: bytes the contract cannot decode, so no one can execute them.
  {
    name: "unknown mutation ID",
    via: "enqueue",
    expect: "ignored",
    signing: (context) => ({
      id: 5 + below(context.random, BUILTIN_MUTATIONS.CreateAccount.id - 5),
    }),
  },
  {
    // Shorter than a word, so not even a static field fits.
    name: "mutationData truncated",
    via: "enqueue",
    expect: "ignored",
    bytes: (args, context) => ({
      ...args,
      mutationData: Hex.slice(args.mutationData, 0, below(context.random, 32)),
    }),
  },
  {
    name: "mutationData with an invalid bool",
    via: "enqueue",
    expect: "ignored",
    bytes: (args, context) => ({
      ...args,
      mutationData: setWord(
        args.mutationData,
        shouldRevertWord(context),
        Hex.fromNumber(2 + below(context.random, 254), { size: 32 }),
      ),
    }),
  },
  {
    // Shorter than the head, so the authorization's fields do not fit.
    name: "authorizationData truncated",
    via: "enqueue",
    expect: "ignored",
    bytes: (args, context) => ({
      ...args,
      authorizationData: Hex.slice(
        args.authorizationData,
        0,
        below(context.random, AUTHORIZATION_HEAD_SIZE),
      ),
    }),
  },
  ...[0x1000n, 1n << 255n, MAX_UINT256].map(
    (offset): Malformation => ({
      name: `authorizationData offset ${Hex.fromNumber(offset)}`,
      via: "enqueue",
      expect: "ignored",
      bytes: (args) => ({
        ...args,
        authorizationData: setWord(
          args.authorizationData,
          AUTHORIZATION_WORD.offset,
          Hex.fromNumber(offset, { size: 32 }),
        ),
      }),
    }),
  ),
  ...(["credentialID", "expiration"] as const).map(
    (field): Malformation => ({
      name: `authorizationData ${field} with dirty high bits`,
      via: "enqueue",
      expect: "ignored",
      bytes: (args) => ({
        ...args,
        authorizationData: dirtyWord(
          args.authorizationData,
          AUTHORIZATION_WORD[field],
        ),
      }),
    }),
  ),

  // `enqueue`: bytes the contract decodes to the well-formed mutation.
  {
    // The signature covers the bytes the contract got.
    name: "mutationData with trailing bytes, signed over them",
    via: "enqueue",
    expect: "executed",
    bytes: (args, context) => {
      const mutationData = Hex.concat(
        args.mutationData,
        randomBytes(context.random, 1 + below(context.random, 64)),
      );
      return {
        ...args,
        mutationData,
        authorizationData: authorizeBytes(context, args.mutation, mutationData),
      };
    },
  },
  {
    name: "authorizationData with trailing bytes",
    via: "enqueue",
    expect: "executed",
    bytes: (args, context) => ({
      ...args,
      authorizationData: Hex.concat(
        args.authorizationData,
        randomBytes(context.random, 1 + below(context.random, 64)),
      ),
    }),
  },
  {
    name: "authorizationData with a gap before the tuple",
    via: "enqueue",
    expect: "executed",
    bytes: (args, context) => ({
      ...args,
      authorizationData: Hex.concat(
        Hex.fromNumber(0x40, { size: 32 }),
        randomBytes(context.random, 32),
        Hex.slice(args.authorizationData, 32),
      ),
    }),
  },

  // `enqueue`: well encoded, with an authorization the contract rejects.
  {
    // The signature covers the canonical bytes, not the ones the contract got.
    name: "mutationData with trailing bytes",
    via: "enqueue",
    expect: rejected("InvalidSignature"),
    bytes: (args, context) => ({
      ...args,
      mutationData: Hex.concat(
        args.mutationData,
        randomBytes(context.random, 1 + below(context.random, 64)),
      ),
    }),
  },
  {
    name: "under its twin's mutation ID",
    via: "enqueue",
    appliesTo: ["A", "B"],
    expect: rejected("InvalidSignature"),
    bytes: (args, context) => ({
      ...args,
      mutation: idOf(context, TWINS[context.mutation.name]!),
    }),
  },
  {
    name: "signed by another key",
    via: "enqueue",
    expect: rejected("InvalidSignature"),
    signing: (context) => ({ by: context.stranger }),
  },
  {
    name: "garbage signature",
    via: "enqueue",
    expect: BAD_SIGNATURE,
    bytes: (args, context) => ({
      ...args,
      authorizationData: encodeAuthorizationCalldata({
        ...context.mutation.authorization,
        signature: randomBytes(context.random, 96),
      }),
    }),
  },
  {
    name: "unknown account",
    via: "enqueue",
    expect: rejected("AccountNotFound"),
    signing: (context) => ({ accountID: randomBytes(context.random, 32) }),
  },
  {
    name: "nonce out of sequence",
    via: "enqueue",
    expect: rejected("InvalidNonce"),
    signing: (context) => ({ nonce: nonceOf(context) + 1n }),
  },
  {
    name: "unknown credential",
    via: "enqueue",
    expect: rejected("CredentialNotFound"),
    signing: () => ({ credentialID: 1n }),
  },
];

/** The signed mutation, and the ID and bytes its signature covers. */
function sign(
  context: Context,
  signing: Signing = {},
): { mutation: Mutation; id: number; mutationData: Hex.Hex } {
  const { manifest, mutation } = context;
  const name = signing.name ?? mutation.name;
  const params = signing.params ?? mutation.params;
  const config = manifest.mutations[name];
  const fields = {
    accountID: signing.accountID ?? mutation.authorization.accountID,
    credentialID: signing.credentialID ?? mutation.authorization.credentialID,
    nonce: signing.nonce ?? mutation.authorization.nonce,
    expiration: mutation.authorization.expiration,
  };
  const mutationData = encodeMutationCalldata({
    config,
    params,
    authorization: { ...fields, signature: "0x" },
  } as Parameters<typeof encodeMutationCalldata>[0]);
  const id = signing.id ?? config.id;
  const signature = (signing.by ?? context.signer).sign(
    payload(manifest, id, mutationData, fields, signing.chainId),
  );
  return {
    mutation: {
      name,
      params,
      authorization: { ...fields, signature },
    } as Mutation,
    id,
    mutationData,
  };
}

/** The encoded authorization of the step's mutation, signed over the bytes `mutationData`. */
function authorizeBytes(
  context: Context,
  id: number,
  mutationData: Hex.Hex,
): Hex.Hex {
  const { signature: _, ...fields } = context.mutation.authorization;
  const signature = context.signer.sign(
    payload(context.manifest, id, mutationData, fields),
  );
  return encodeAuthorizationCalldata({ ...fields, signature });
}

/** The EIP-712 payload of an authorization over the bytes `mutationData`, as `_authorizationDigest` hashes it. */
function payload(
  manifest: Manifest,
  mutation: number,
  mutationData: Hex.Hex,
  fields: Omit<Authorization, "signature">,
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
      accountID: fields.accountID,
      credentialID: fields.credentialID,
      nonce: fields.nonce,
      // ox types `uint40` as a number.
      expiration: Number(fields.expiration),
      mutation,
      mutationData,
    },
  });
}

function configOf(context: Context) {
  return context.manifest.mutations[context.mutation.name];
}

function idOf(context: Context, name: AppMutationName): number {
  return context.manifest.mutations[name].id;
}

function nonceOf(context: Context): bigint {
  return context.mutation.authorization.nonce;
}

function paramsOf(input: Input): Record<string, unknown> {
  return input.params as Record<string, unknown>;
}

function withParam(input: Input, name: string, value: unknown): Input {
  return { ...input, params: { ...paramsOf(input), [name]: value } };
}

function withAuthorization(input: Input, field: string, value: unknown): Input {
  return {
    ...input,
    authorization: { ...input.authorization, [field]: value },
  };
}

/** Draws one of the step's params whose type passes `filter`. */
function pickParam(
  context: Context,
  filter: (type: string) => boolean = () => true,
): { name: string; type: string } {
  const params = configOf(context).params.filter((param) => filter(param.type));
  return params[below(context.random, params.length)]!;
}

/** The width of an integer type, or `undefined` for any other type. */
function bitsOf(type: string): number | undefined {
  const match = /^u?int(\d*)$/.exec(type);
  return match === null ? undefined : Number(match[1] || 256);
}

/** A value of the wrong JavaScript type for an ABI `type`. */
function wrongType(type: string): unknown {
  if (type.endsWith("]")) return "not an array";
  if (bitsOf(type) !== undefined) return "not a number";
  if (type === "bool") return "false";
  if (type === "address") return "0x1234";
  if (type === "bytes") return "not hex";
  if (type === "string") return 7;
  // `bytesN`.
  return "0x12";
}

/** A value just outside an integer `type`. */
function outOfRange(type: string, context: Context): bigint {
  const bits = BigInt(bitsOf(type)!);
  if (type.startsWith("int")) {
    const max = 1n << (bits - 1n);
    return context.random.nextDoubleUnsafe() < 0.5 ? max : -max - 1n;
  }
  return context.random.nextDoubleUnsafe() < 0.5 ? -1n : 1n << bits;
}

/** Applies `map` to every integer the params hold, outside arrays. */
function mapIntegers(
  params: Record<string, unknown>,
  map: (value: bigint | number) => unknown,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([name, value]) => [
      name,
      typeof value === "bigint" || typeof value === "number"
        ? map(value)
        : value,
    ]),
  );
}

/** The word of the step's `mutationData` that holds `shouldRevert`: where its encodings with `false` and `true` differ. */
function shouldRevertWord(context: Context): number {
  const encode = (shouldRevert: boolean) =>
    encodeMutationCalldata({
      config: configOf(context),
      params: { ...context.mutation.params, shouldRevert },
      authorization: context.mutation.authorization,
    } as Parameters<typeof encodeMutationCalldata>[0]).slice(2);
  const [a, b] = [encode(false), encode(true)];
  let word = 0;
  while (
    a.slice(word * 64, (word + 1) * 64) === b.slice(word * 64, (word + 1) * 64)
  ) {
    word++;
  }
  return word;
}

/** The words of `encodeAuthorizationCalldata`: the tuple's offset, then its fields. */
const AUTHORIZATION_WORD = {
  offset: 0,
  credentialID: 2,
  expiration: 4,
} as const;

/** `encodeAuthorizationCalldata` up to the signature: the offset and the five head words. */
const AUTHORIZATION_HEAD_SIZE = 6 * 32;

/** Replaces the 32-byte word at `index` of `data`. */
function setWord(data: Hex.Hex, index: number, word: Hex.Hex): Hex.Hex {
  const hex = data.slice(2);
  return `0x${hex.slice(0, index * 64)}${word.slice(2)}${hex.slice((index + 1) * 64)}`;
}

/** Sets the top byte of the word at `index`, above any type narrower than `uint256`. */
function dirtyWord(data: Hex.Hex, index: number): Hex.Hex {
  const word = data.slice(2 + index * 64, 2 + (index + 1) * 64);
  return setWord(data, index, `0xff${word.slice(2)}`);
}

function below(random: Random.Random, length: number): number {
  return Math.floor(random.nextDoubleUnsafe() * length);
}

function randomBytes(random: Random.Random, size: number): Hex.Hex {
  return Hex.fromBytes(
    Uint8Array.from({ length: size }, () => below(random, 256)),
  );
}
