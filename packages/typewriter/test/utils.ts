import { parseAbiParameters } from "abitype";
import { AbiParameters, Hex as OxHex, P256, Secp256k1 } from "ox";
import { Authentication } from "ox/webauthn";
import { type Address, encodeDeployData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sendRawTransactionSync } from "viem/actions";
import { anvil } from "viem/chains";
import {
  authorizeMutation,
  deriveAccountID,
  getAuthorizationPayload,
  KeyType,
  packNonce,
  type TypedMutation,
} from "../src/client";
import type {
  ResolvedTypewriterMutationConfig,
  TypewriterManifest,
} from "../src/config";
import { BUILTIN_MUTATIONS } from "../src/config";
import { SCHEDULER_ACCOUNT, TEST_WALLET_CLIENT } from "./setup";

async function deployContract(name: string): Promise<Address> {
  const artifact = await Bun.file(
    `${import.meta.dir}/contracts/out/${name}.sol/${name}.json`,
  ).json();
  const data = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as Hex,
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

export const deployCounter = (): Promise<Address> => deployContract("Counter");
export const deployHarness = (): Promise<Address> => deployContract("Harness");

export const COUNTER_MUTATIONS = {
  Add: {
    id: 0,
    params: parseAbiParameters("uint256 amount"),
  },
  ...BUILTIN_MUTATIONS,
} as const satisfies Record<string, ResolvedTypewriterMutationConfig>;

export const HARNESS_MUTATIONS = {
  Credit: {
    id: 0,
    params: parseAbiParameters("uint256 amount"),
  },
  Debit: {
    id: 1,
    params: parseAbiParameters("uint256 amount"),
  },
  Assert: {
    id: 2,
    params: parseAbiParameters("uint256 expected"),
  },
  ...BUILTIN_MUTATIONS,
} as const satisfies Record<string, ResolvedTypewriterMutationConfig>;

function fixtureManifest<
  const mutations extends Record<string, ResolvedTypewriterMutationConfig>,
>(mutations: mutations, address: Address, chainId: number) {
  return { address, chainId, mutations } as const;
}

export function secp256k1PublicKey(address: Address): Hex {
  return AbiParameters.encode(parseAbiParameters("address"), [address]);
}

export function p256PublicKey(privateKey: Hex): Hex {
  const publicKey = P256.getPublicKey({ privateKey });
  return AbiParameters.encode(parseAbiParameters("uint256 x, uint256 y"), [
    BigInt(publicKey.x),
    BigInt(publicKey.y),
  ]);
}

export function nativeAccountID(keyType: number, publicKey: Hex): Hex {
  if (keyType !== 0 && keyType !== 1 && keyType !== 2) {
    throw new RangeError(`unknown key type: ${keyType}`);
  }
  return deriveAccountID({ keyType, publicKey });
}

export function signP256Raw(digest: Hex, privateKey: Hex): Hex {
  const signature = P256.sign({ payload: digest, privateKey, hash: true });
  return AbiParameters.encode(parseAbiParameters("uint256 r, uint256 s"), [
    BigInt(signature.r),
    BigInt(signature.s),
  ]);
}

export function signWebAuthnP256Raw(digest: Hex, privateKey: Hex): Hex {
  const { metadata, payload } = Authentication.getSignPayload({
    challenge: digest,
    rpId: "",
    origin: "",
    userVerification: "required",
  });
  const signature = P256.sign({ payload, privateKey, hash: true });
  const challengeOffset =
    metadata.clientDataJSON.indexOf('"challenge":"') + '"challenge":"'.length;
  return AbiParameters.encode(
    parseAbiParameters(
      "bytes authenticatorData, bytes clientDataJSON, uint256 challengeOffset, uint256 r, uint256 s",
    ),
    [
      metadata.authenticatorData,
      OxHex.fromString(metadata.clientDataJSON),
      BigInt(challengeOffset),
      BigInt(signature.r),
      BigInt(signature.s),
    ],
  );
}

export function signSecp256k1Raw(digest: Hex, privateKey: Hex): Hex {
  const signature = Secp256k1.sign({ payload: digest, privateKey });
  return AbiParameters.encode(
    parseAbiParameters("uint8 v, bytes32 r, bytes32 s"),
    [signature.yParity + 27, signature.r, signature.s],
  );
}

type AuthorizationSigner = (digest: Hex) => Hex;

function authorizationSigner(
  keyType: number,
  privateKey: Hex,
): AuthorizationSigner {
  if (keyType === KeyType.P256) {
    return (digest: Hex) => signP256Raw(digest, privateKey);
  }
  if (keyType === KeyType.WebAuthnP256) {
    return (digest: Hex) => signWebAuthnP256Raw(digest, privateKey);
  }
  if (keyType === KeyType.Secp256k1) {
    return (digest: Hex) => signSecp256k1Raw(digest, privateKey);
  }
  throw new RangeError(`unknown key type: ${keyType}`);
}

export function authorizationRequest(params: {
  accountID: Hex;
  credentialID?: bigint;
  lane?: bigint;
  sequence: bigint;
  expiration?: bigint;
}) {
  return {
    accountID: params.accountID,
    credentialID: params.credentialID ?? 0n,
    nonce: packNonce(params.lane ?? 0n, params.sequence),
    expiration: params.expiration ?? 0n,
  };
}

function authorize<
  const manifest extends TypewriterManifest,
  const name extends keyof manifest["mutations"] & string,
>(
  manifest: manifest,
  mutation: TypedMutation<manifest, name>,
  keyType: number,
  privateKey: Hex,
) {
  const signer = authorizationSigner(keyType, privateKey);
  return authorizeMutation(
    mutation,
    signer(getAuthorizationPayload(manifest, mutation)),
  );
}

export function prepareCounterCreateAccount(params: {
  privateKey: Hex;
  address: Address;
  chainId: number;
}) {
  const publicKey = secp256k1PublicKey(
    privateKeyToAccount(params.privateKey).address,
  );
  const manifest = fixtureManifest(
    COUNTER_MUTATIONS,
    params.address,
    params.chainId,
  );
  const accountID = nativeAccountID(KeyType.Secp256k1, publicKey);
  return authorize(
    manifest,
    {
      name: "CreateAccount",
      params: { keyType: KeyType.Secp256k1, publicKey },
      accountID,
      credentialID: 0n,
      nonce: 0n,
      expiration: 0n,
    },
    KeyType.Secp256k1,
    params.privateKey,
  );
}

export function prepareCounterAdd(params: {
  privateKey: Hex;
  address: Address;
  chainId: number;
  amount: bigint;
  sequence: bigint;
}) {
  const publicKey = secp256k1PublicKey(
    privateKeyToAccount(params.privateKey).address,
  );
  const accountID = nativeAccountID(KeyType.Secp256k1, publicKey);
  const manifest = fixtureManifest(
    COUNTER_MUTATIONS,
    params.address,
    params.chainId,
  );
  const request = authorizationRequest({
    accountID,
    sequence: params.sequence,
  });
  return authorize(
    manifest,
    { name: "Add", params: { amount: params.amount }, ...request },
    KeyType.Secp256k1,
    params.privateKey,
  );
}

export function prepareHarnessCreateAccount(params: {
  keyType: number;
  publicKey: Hex;
  privateKey: Hex;
  address: Address;
  chainId: number;
}) {
  if (params.keyType !== 0 && params.keyType !== 1 && params.keyType !== 2) {
    throw new RangeError(`unknown key type: ${params.keyType}`);
  }
  const manifest = fixtureManifest(
    HARNESS_MUTATIONS,
    params.address,
    params.chainId,
  );
  const accountID = nativeAccountID(params.keyType, params.publicKey);
  return authorize(
    manifest,
    {
      name: "CreateAccount",
      params: { keyType: params.keyType, publicKey: params.publicKey },
      accountID,
      credentialID: 0n,
      nonce: 0n,
      expiration: 0n,
    },
    params.keyType,
    params.privateKey,
  );
}

type HarnessMutation =
  | { mutation: "Credit"; params: { amount: bigint } }
  | { mutation: "Debit"; params: { amount: bigint } }
  | { mutation: "Assert"; params: { expected: bigint } };

export function prepareHarnessMutation(
  params: HarnessMutation & {
    accountID: Hex;
    credentialID?: bigint;
    lane?: bigint;
    sequence: bigint;
    keyType: number;
    privateKey: Hex;
    address: Address;
    chainId: number;
  },
) {
  const manifest = fixtureManifest(
    HARNESS_MUTATIONS,
    params.address,
    params.chainId,
  );
  const request = authorizationRequest({
    accountID: params.accountID,
    credentialID: params.credentialID,
    lane: params.lane,
    sequence: params.sequence,
  });
  if (params.mutation === "Assert") {
    return authorize(
      manifest,
      {
        name: "Assert",
        params: params.params,
        ...request,
      },
      params.keyType,
      params.privateKey,
    );
  }
  if (params.mutation === "Debit") {
    return authorize(
      manifest,
      {
        name: "Debit",
        params: params.params,
        ...request,
      },
      params.keyType,
      params.privateKey,
    );
  }
  return authorize(
    manifest,
    { name: "Credit", params: params.params, ...request },
    params.keyType,
    params.privateKey,
  );
}
