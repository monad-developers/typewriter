import type { AbiParameters } from "ox";
import type { Abi } from "viem";
import type { ResolvedTypewriterMutationConfig } from "./config";

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

/** A `KeyType.Secp256k1` signature, in `verifySecp256k1`. */
export const SECP256K1_SIGNATURE_PARAMS = [
  { name: "v", type: "uint8" },
  { name: "r", type: "bytes32" },
  { name: "s", type: "bytes32" },
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
      {
        name: "batches",
        type: "tuple[]",
        components: [
          { name: "mutations", type: "uint8[]" },
          { name: "mutationData", type: "bytes[]" },
          { name: "authorizationData", type: "bytes[]" },
        ],
      },
      { name: "forceExecuteIndexes", type: "uint256[]" },
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
    type: "event",
    name: "ForceInclusionQueued",
    inputs: [
      { name: "index", type: "uint256", indexed: false },
      { name: "mutation", type: "uint8", indexed: false },
      { name: "mutationData", type: "bytes", indexed: false },
      { name: "authorizationData", type: "bytes", indexed: false },
      { name: "enqueuedBlock", type: "uint256", indexed: false },
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
