import { parseAbiParameters } from "abitype";
import {
  type Abi,
  AbiParameters,
  Hash,
  Hex as OxHex,
  P256,
  Secp256k1,
  type TypedData,
} from "ox";
import { Authentication } from "ox/webauthn";
import {
  type AccountStorage,
  type ConcreteStorageVariable,
  decodeStorageVariable,
  getStorageSlot,
  type StorageLayout,
  type StorageVariableToPrimitiveType,
} from "storage-layout";
import { type Address, encodeDeployData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sendRawTransactionSync } from "viem/actions";
import { anvil } from "viem/chains";
import type { TypewriterMutation } from "../src";
import { TYPEWRITER_DOMAIN } from "../src";
import type { ResolvedTypewriterMutationConfig } from "../src/config";
import { hashMutationEip712 } from "../src/eip712";
import {
  SCHEDULER_ACCOUNT,
  TEST_PUBLIC_CLIENT,
  TEST_WALLET_CLIENT,
} from "./setup";

export const COUNTER_SIGNATURE_PARAMS = parseAbiParameters(
  "bytes32 accountId, bytes publicKey, bytes rawSignature",
);
export const HARNESS_SIGNATURE_PARAMS = parseAbiParameters(
  "bytes32 account, uint64 keyId, uint8 keyType, bytes rawSignature",
);

export const EMPTY_STORAGE_LAYOUT = {
  storage: [],
  types: {},
} as const satisfies StorageLayout;

// Minimal ABI for tests that createTypewriter without a real contract. Contains the
// execute function and ForceInclusionQueued event so the runtime and watch
// layer have the shapes they expect.
export const STUB_TYPEWRITER_ABI = [
  {
    type: "function",
    name: "execute",
    inputs: [
      {
        name: "batches",
        type: "tuple[]",
        internalType: "struct Batch[]",
        components: [
          { name: "mutations", type: "uint8[]", internalType: "uint8[]" },
          { name: "mutationData", type: "bytes[]", internalType: "bytes[]" },
          {
            name: "signatureData",
            type: "bytes[]",
            internalType: "bytes[]",
          },
        ],
      },
      {
        name: "forceExecuteIndexes",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "ForceInclusionQueued",
    inputs: [
      {
        name: "index",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "mutation",
        type: "uint8",
        indexed: false,
        internalType: "uint8",
      },
      {
        name: "mutationData",
        type: "bytes",
        indexed: false,
        internalType: "bytes",
      },
      {
        name: "signatureData",
        type: "bytes",
        indexed: false,
        internalType: "bytes",
      },
      {
        name: "enqueuedBlock",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
] as const satisfies Abi.Abi;

// Deploy a forge-built contract by name. Reads the artifact from the
// contracts workspace, broadcasts via the test wallet, waits for the
// receipt, returns the deployed address.
async function deployContract(
  name: string,
  constructorParams?: readonly unknown[],
): Promise<Address> {
  const artifact = await Bun.file(
    `${import.meta.dir}/contracts/out/${name}.sol/${name}.json`,
  ).json();
  const data = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as Hex,
    // biome-ignore lint/suspicious/noExplicitAny: viem deployContract args type
    args: constructorParams as any,
  });

  const request = await TEST_WALLET_CLIENT.prepareTransactionRequest({
    account: SCHEDULER_ACCOUNT,
    chain: anvil,
    data,
  });
  const signed = await TEST_WALLET_CLIENT.signTransaction(request);
  const receipt = await sendRawTransactionSync(TEST_WALLET_CLIENT, {
    serializedTransaction: signed,
  });
  if (
    receipt.contractAddress === null ||
    receipt.contractAddress === undefined
  ) {
    throw new Error(`${name} deploy missing address`);
  }
  return receipt.contractAddress;
}

// Deploy Counter. The contract hardcodes its EIP-712 domain (name="Counter",
// version="1") and takes no constructor params. The parameter is retained only
// so existing call sites don't need to care about the constructor change.
export async function deployCounter(_: Address): Promise<Address> {
  return deployContract("Counter");
}

export const deployHarness = (): Promise<Address> => deployContract("Harness");

export async function readContractStorage<
  layout extends StorageLayout,
  variable extends ConcreteStorageVariable<layout>,
>(
  layout: layout,
  address: Address,
  variable: variable,
): Promise<StorageVariableToPrimitiveType<layout, variable>> {
  // @ts-expect-error
  const slots = getStorageSlot(layout, variable);
  const values = await Promise.all(
    slots.map((slot) => TEST_PUBLIC_CLIENT.getStorageAt({ address, slot })),
  );
  const storage = Object.fromEntries(
    slots.map((slot, index) => [slot, values[index]!]),
  ) as AccountStorage;

  return decodeStorageVariable(layout, variable, storage);
}

// Mutation definitions for the Counter test fixture. The contract/revm owns
// acceptance and state transitions; this config only describes encoding.
export const COUNTER_MUTATIONS = {
  NewAccount: {
    tag: 0,
    params: parseAbiParameters("uint8 keyType, bytes publicKey"),
  },
  Add: {
    tag: 1,
    params: parseAbiParameters("uint256 amount, uint256 nonce"),
  },
} as const satisfies {
  NewAccount: ResolvedTypewriterMutationConfig;
  Add: ResolvedTypewriterMutationConfig;
};

export function counterAccountId(publicKey: Hex): Hex {
  return Hash.keccak256(publicKey) as Hex;
}

export function counterNewAccountMutation(params: {
  address: Address;
}): TypewriterMutation<
  "NewAccount",
  typeof COUNTER_MUTATIONS.NewAccount,
  typeof COUNTER_SIGNATURE_PARAMS
> {
  const publicKey = secp256k1PublicKey(params.address);
  return {
    name: "NewAccount",
    params: { keyType: 2, publicKey },
    signature: {
      accountId: counterAccountId(publicKey),
      publicKey,
      rawSignature: "0x",
    },
  };
}

// Sign Counter's `add` mutation. The runtime ABI-encodes this record against
// COUNTER_SIGNATURE_PARAMS before passing it through Typewriter's signatureData channel.
export function signCounter(params: {
  privateKey: Hex;
  amount: bigint;
  nonce: bigint;
  address: Address;
  chainId: number;
}): {
  readonly accountId: Hex;
  readonly publicKey: Hex;
  readonly rawSignature: Hex;
} {
  const domain: TypedData.Domain = {
    ...TYPEWRITER_DOMAIN,
    chainId: params.chainId,
    verifyingContract: params.address,
  };
  const digest = hashMutationEip712(
    COUNTER_MUTATIONS.Add,
    "Add",
    { amount: params.amount, nonce: params.nonce },
    domain,
  );
  const signerAddress = privateKeyToAccount(params.privateKey).address;
  const publicKey = secp256k1PublicKey(signerAddress);
  const rawSignature = signSecp256k1Raw(digest, params.privateKey);
  return { accountId: counterAccountId(publicKey), publicKey, rawSignature };
}

// Mutation definitions for the Harness test fixture. Tags match the contract:
//   initialize (0): bootstraps an account with a root key. Account id is
//                    derived as keccak256(rootPublicKey); no signature.
//   authorize  (1): adds a key to an existing account. Signed by an
//                    existing key.
//   credit     (2): adds amount to balance. Signed.
//   debit      (3): subtracts amount from balance onchain. Signed.
//   assert     (4): read-only check; the contract reverts if balance !=
//                    expected. Signed.
export const HARNESS_MUTATIONS = {
  Initialize: {
    tag: 0,
    params: parseAbiParameters("uint8 rootKeyType, bytes rootPublicKey"),
  },
  Authorize: {
    tag: 1,
    params: parseAbiParameters(
      "bytes32 account, uint64 keyId, uint8 keyType, bytes publicKey, uint256 nonce",
    ),
  },
  Credit: {
    tag: 2,
    params: parseAbiParameters(
      "bytes32 account, uint64 keyId, uint256 amount, uint256 nonce",
    ),
  },
  Debit: {
    tag: 3,
    params: parseAbiParameters(
      "bytes32 account, uint64 keyId, uint256 amount, uint256 nonce",
    ),
  },
  Assert: {
    tag: 4,
    params: parseAbiParameters(
      "bytes32 account, uint64 keyId, uint256 expected, uint256 nonce",
    ),
  },
} as const satisfies {
  Initialize: ResolvedTypewriterMutationConfig;
  Authorize: ResolvedTypewriterMutationConfig;
  Credit: ResolvedTypewriterMutationConfig;
  Debit: ResolvedTypewriterMutationConfig;
  Assert: ResolvedTypewriterMutationConfig;
};

// Derive the bytes32 account id from a public key (matches Harness.sol's
// `keccak256(rootPublicKey)` bootstrap rule).
export function harnessAccountId(publicKey: Hex): Hex {
  return Hash.keccak256(publicKey) as Hex;
}

// secp256k1 public key for an EOA, in the abi.encode(address) form
// Typewriter.sol's verifySecp256k1 expects.
export function secp256k1PublicKey(address: Address): Hex {
  return AbiParameters.encode(parseAbiParameters("address"), [address]);
}

// P-256 public key for a private key, in the abi.encode(uint256 x, uint256 y)
// form Typewriter.sol's verifyP256 / decodeP256PublicKey accepts.
export function p256PublicKey(privateKey: Hex): Hex {
  const pk = P256.getPublicKey({ privateKey });
  return AbiParameters.encode(parseAbiParameters("uint256 x, uint256 y"), [
    pk.x,
    pk.y,
  ]);
}

// Sign a digest with a P-256 private key. Returns rawSignature in the
// abi.encode(uint256 r, uint256 s) form. The contract sha256s the digest
// before passing to the precompile, so we sign with hash: true to match.
export function signP256Raw(digest: Hex, privateKey: Hex): Hex {
  const sig = P256.sign({ payload: digest, privateKey, hash: true });
  return AbiParameters.encode(parseAbiParameters("uint256 r, uint256 s"), [
    sig.r,
    sig.s,
  ]);
}

// Sign a digest as a WebAuthn-P256 challenge. Returns rawSignature in the
// abi.encode(bytes authData, bytes clientDataJSON, uint256 challengeOffset,
// uint256 r, uint256 s) form Typewriter.sol's verifyWebAuthnP256 expects.
//
// rpId/origin are fixed to empty strings — Typewriter.sol doesn't inspect
// either, so their values don't affect on-chain verification. Real apps
// that care about origin enforcement would do that check off-chain
// (browser refuses to sign for the wrong RP ID anyway).
export function signWebAuthnP256Raw(digest: Hex, privateKey: Hex): Hex {
  const { metadata, payload } = Authentication.getSignPayload({
    challenge: digest,
    rpId: "",
    origin: "",
    userVerification: "required",
  });
  const sig = P256.sign({ payload, privateKey, hash: true });
  // Typewriter.sol's verifyChallenge expects the byte offset at which the
  // base64url-encoded challenge VALUE starts inside clientDataJSON. ox's
  // `challengeIndex` points at the JSON key (`"challenge":"`), so add 13
  // to land on the first byte of the value.
  const challengeOffset =
    metadata.clientDataJSON.indexOf('"challenge":"') + '"challenge":"'.length;
  return AbiParameters.encode(
    parseAbiParameters(
      "bytes authData, bytes clientDataJSON, uint256 challengeOffset, uint256 r, uint256 s",
    ),
    [
      metadata.authenticatorData,
      OxHex.fromString(metadata.clientDataJSON),
      BigInt(challengeOffset),
      sig.r,
      sig.s,
    ],
  );
}

// Sign one of Harness's signed mutation types. Returns the structured
// signature typewriter encodes into batch.signatureData[i].
export function signHarness(params: {
  keyType: number;
  privateKey: Hex;
  mutation: "Authorize" | "Credit" | "Debit" | "Assert";
  params: Record<string, unknown>;
  address: Address;
  chainId: number;
}): Hex {
  const domain: TypedData.Domain = {
    ...TYPEWRITER_DOMAIN,
    chainId: params.chainId,
    verifyingContract: params.address,
  };
  const digest = hashMutationEip712(
    HARNESS_MUTATIONS[params.mutation],
    params.mutation,
    params.params,
    domain,
  );
  if (params.keyType === 0) return signP256Raw(digest, params.privateKey);
  if (params.keyType === 1)
    return signWebAuthnP256Raw(digest, params.privateKey);
  if (params.keyType === 2) return signSecp256k1Raw(digest, params.privateKey);
  throw new Error(`signHarness: unknown keyType ${params.keyType}`);
}

export function encodeHarnessSignature(params: {
  readonly account: Hex;
  readonly keyId: bigint;
  readonly keyType: number;
  readonly rawSignature: Hex;
}): typeof params {
  return params;
}

function signSecp256k1Raw(digest: Hex, privateKey: Hex): Hex {
  const signature = Secp256k1.sign({ payload: digest, privateKey });
  return AbiParameters.encode(
    parseAbiParameters("uint8 v, bytes32 r, bytes32 s"),
    [
      signature.yParity + 27,
      OxHex.fromNumber(signature.r, { size: 32 }),
      OxHex.fromNumber(signature.s, { size: 32 }),
    ],
  );
}

// Bootstrap an account by submitting an `initialize` mutation. Returns the
// derived account id so callers can reference it. The signature is unused
// by the contract (initialize is bootstrap) but typewriter's wire format still
// requires a structured value, so we pass a stub.
export async function setupHarnessAccount(
  // biome-ignore lint/suspicious/noExplicitAny: structural typing for the typewriter instance
  typewriter: { execute: (m: any) => Promise<any> },
  params: { rootKeyType: number; rootPublicKey: Hex },
): Promise<Hex> {
  const account = harnessAccountId(params.rootPublicKey);
  await typewriter.execute({
    name: "Initialize",
    params: {
      rootKeyType: params.rootKeyType,
      rootPublicKey: params.rootPublicKey,
    },
    signature: encodeHarnessSignature({
      account,
      keyId: 0n,
      keyType: params.rootKeyType,
      rawSignature: "0x",
    }),
  });
  return account;
}
