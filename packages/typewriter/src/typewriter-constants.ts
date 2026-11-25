import type { AbiParameters } from "ox";
import type { Spec } from "typewriter-evm";
import type { Abi } from "viem";
import type { ResolvedTypewriterMutationConfig } from "./config";

/**
 * The hardfork mutations execute under and settlements are priced for, unless
 * the config pins another. It stays the same for the runtime's life.
 */
export const DEFAULT_HARDFORK: Spec = "MonadTen";

/** `enum KeyType`. */
export const KeyType = {
  P256: 0,
  WebAuthnP256: 1,
  Secp256k1: 2,
} as const;

export type KeyType = (typeof KeyType)[keyof typeof KeyType];

/** The `publicKey` of a `KeyType.Secp256k1` credential, in `verifySecp256k1`. */
export const SECP256K1_PUBLIC_KEY_PARAMS = [
  { name: "address", type: "address" },
] as const satisfies readonly AbiParameters.Parameter[];

/**
 * The ABI-encoded `publicKey` of a P-256 credential, in `decodeP256PublicKey`.
 * The contract also accepts a 65-byte uncompressed key.
 */
export const P256_PUBLIC_KEY_PARAMS = [
  { name: "x", type: "uint256" },
  { name: "y", type: "uint256" },
] as const satisfies readonly AbiParameters.Parameter[];

/** A `KeyType.P256` signature, in `verifyP256`. */
export const P256_SIGNATURE_PARAMS = [
  { name: "r", type: "uint256" },
  { name: "s", type: "uint256" },
] as const satisfies readonly AbiParameters.Parameter[];

/** A `KeyType.WebAuthnP256` signature, in `verifyWebAuthnP256`. */
export const WEBAUTHN_P256_SIGNATURE_PARAMS = [
  { name: "authenticatorData", type: "bytes" },
  { name: "clientDataJSON", type: "bytes" },
  { name: "challengeOffset", type: "uint256" },
  { name: "r", type: "uint256" },
  { name: "s", type: "uint256" },
] as const satisfies readonly AbiParameters.Parameter[];

/**
 * The built-in mutations: their IDs (`CREATE_ACCOUNT_MUTATION`, ...) and
 * params (`struct CreateAccount`, ...).
 */
export const BUILTIN_MUTATIONS = {
  CreateAccount: {
    id: 253,
    params: [
      { name: "keyType", type: "uint8" },
      { name: "publicKey", type: "bytes" },
    ],
  },
  AddCredential: {
    id: 254,
    params: [
      { name: "expiration", type: "uint40" },
      { name: "keyType", type: "uint8" },
      { name: "permissions", type: "uint256" },
      { name: "publicKey", type: "bytes" },
    ],
  },
  RemoveCredential: {
    id: 255,
    params: [{ name: "credentialID", type: "uint64" }],
  },
} as const satisfies Record<string, ResolvedTypewriterMutationConfig>;

/** The lowest built-in mutation ID. App mutation IDs must be below it. */
export const FIRST_BUILTIN_MUTATION_ID = 253;

/**
 * `MAX_SETTLEMENT_DELAY` in Typewriter.sol: how many seconds after its pinned
 * timestamp a settlement can land. An authorization must outlast it, so none
 * executes after it expires.
 */
export const EXPIRATION_MARGIN = 60;

/**
 * The fee cap of every transaction the runtime sends: 100 times Monad's
 * minimum base fee of 100 gwei. A settlement is signed once and sent again
 * unchanged, so it can land only while the base fee is under this. It pays
 * only the base fee plus the tip, and Monad checks balances against that, not
 * the cap, so a high cap costs nothing.
 */
export const MAX_FEE_PER_GAS = 10_000_000_000_000n;

/** The tip of every transaction the runtime sends, what `eth_maxPriorityFeePerGas` returns on Monad. */
export const MAX_PRIORITY_FEE_PER_GAS = 2_000_000_000n;

/**
 * `ROOT_PERMISSIONS`: an account credential with both adds and removes any
 * credential of its account. An account's last one that never expires can't
 * be removed.
 */
export const ROOT_PERMISSIONS =
  (1n << BigInt(BUILTIN_MUTATIONS.AddCredential.id)) |
  (1n << BigInt(BUILTIN_MUTATIONS.RemoveCredential.id));

/**
 * `enum SchedulerRole`. Every role can authorize `execute`. From `Issuer` up,
 * a scheduler credential adds and removes those of lower roles, and a `Root`
 * any of them.
 */
export const SchedulerRole = {
  Executor: 0,
  Issuer: 1,
  Root: 2,
} as const;

export type SchedulerRole = (typeof SchedulerRole)[keyof typeof SchedulerRole];

/** `struct SchedulerCredential`. */
export const SCHEDULER_CREDENTIAL_ABI_PARAMS = [
  { name: "expiration", type: "uint40" },
  { name: "keyType", type: "uint8" },
  { name: "role", type: "uint8" },
  { name: "publicKey", type: "bytes" },
] as const satisfies readonly AbiParameters.Parameter[];

/** `struct SchedulerAuthorization`. */
export const SCHEDULER_AUTHORIZATION_ABI_PARAMS = [
  { name: "credentialID", type: "uint64" },
  { name: "signature", type: "bytes" },
] as const satisfies readonly AbiParameters.Parameter[];

/** `struct Authorization`. */
export const AUTHORIZATION_ABI_PARAMS = [
  { name: "accountID", type: "bytes32" },
  { name: "credentialID", type: "uint64" },
  { name: "nonce", type: "uint256" },
  { name: "expiration", type: "uint40" },
  { name: "signature", type: "bytes" },
] as const satisfies readonly AbiParameters.Parameter[];

export const TYPEWRITER_ABI = [
  {
    type: "function",
    name: "execute",
    inputs: [
      { name: "fromExecutionHash", type: "bytes32" },
      { name: "timestamp", type: "uint40" },
      {
        name: "batch",
        type: "tuple",
        components: [
          { name: "mutations", type: "uint8[]" },
          { name: "mutationData", type: "bytes[]" },
          { name: "authorizationData", type: "bytes[]" },
        ],
      },
      { name: "forceExecuteIndexes", type: "uint256[]" },
      {
        name: "authorization",
        type: "tuple",
        components: SCHEDULER_AUTHORIZATION_ABI_PARAMS,
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "enqueue",
    inputs: [
      { name: "mutation", type: "uint8" },
      { name: "mutationData", type: "bytes" },
      { name: "authorizationData", type: "bytes" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "forceExecute",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "executionIndex",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "executionHash",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "schedulerNonce",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "schedulerAddCredential",
    inputs: [
      {
        name: "credential",
        type: "tuple",
        components: SCHEDULER_CREDENTIAL_ABI_PARAMS,
      },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint40" },
      {
        name: "authorization",
        type: "tuple",
        components: SCHEDULER_AUTHORIZATION_ABI_PARAMS,
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "schedulerRemoveCredential",
    inputs: [
      { name: "credentialID", type: "uint64" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint40" },
      {
        name: "authorization",
        type: "tuple",
        components: SCHEDULER_AUTHORIZATION_ABI_PARAMS,
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "SchedulerCredentialAdded",
    inputs: [
      { name: "credentialID", type: "uint64", indexed: false },
      {
        name: "credential",
        type: "tuple",
        indexed: false,
        components: SCHEDULER_CREDENTIAL_ABI_PARAMS,
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SchedulerCredentialRemoved",
    inputs: [{ name: "credentialID", type: "uint64", indexed: false }],
    anonymous: false,
  },
  {
    type: "event",
    name: "ForceInclusionQueued",
    inputs: [
      { name: "index", type: "uint256", indexed: false },
      { name: "mutation", type: "uint8", indexed: false },
      { name: "mutationData", type: "bytes", indexed: false },
      { name: "authorizationData", type: "bytes", indexed: false },
      { name: "enqueuedTimestamp", type: "uint40", indexed: false },
    ],
    anonymous: false,
  },
] as const satisfies Abi;

/**
 * `TYPEWRITER_DOMAIN_NAME` and `TYPEWRITER_DOMAIN_VERSION`. The contract adds
 * `chainId` and `verifyingContract`.
 */
export const TYPEWRITER_EIP712_DOMAIN = {
  name: "Typewriter",
  version: "1",
} as const;

/** `AUTHORIZATION_TYPEHASH`. */
export const AUTHORIZATION_EIP712_TYPES = {
  Authorization: [
    { name: "accountID", type: "bytes32" },
    { name: "credentialID", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "expiration", type: "uint40" },
    { name: "mutation", type: "uint8" },
    { name: "mutationData", type: "bytes" },
  ],
} as const;

/**
 * `EXECUTE_TYPEHASH`: what a scheduler credential signs to authorize an
 * `execute` call from one `executionHash` to the next, pinned at `timestamp`,
 * for `relayer` to send.
 */
export const EXECUTE_EIP712_TYPES = {
  Execute: [
    { name: "fromExecutionHash", type: "bytes32" },
    { name: "toExecutionHash", type: "bytes32" },
    { name: "timestamp", type: "uint40" },
    { name: "relayer", type: "address" },
  ],
} as const;

/** `SCHEDULER_ADD_CREDENTIAL_TYPEHASH`. */
export const SCHEDULER_ADD_CREDENTIAL_EIP712_TYPES = {
  SchedulerAddCredential: [
    { name: "expiration", type: "uint40" },
    { name: "keyType", type: "uint8" },
    { name: "role", type: "uint8" },
    { name: "publicKey", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint40" },
  ],
} as const;

/** `SCHEDULER_REMOVE_CREDENTIAL_TYPEHASH`. */
export const SCHEDULER_REMOVE_CREDENTIAL_EIP712_TYPES = {
  SchedulerRemoveCredential: [
    { name: "credentialID", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint40" },
  ],
} as const;
