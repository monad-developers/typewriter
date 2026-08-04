import {
  ALL_PERMISSIONS,
  EIP712_TYPES,
  MAX_DEADLINE,
  type MutationName,
  messageFor,
  PIXEL_WAR_BATCH_ORDER,
} from "pixel-war-sdk";
import { TYPEWRITER_DOMAIN } from "typewriter";
import {
  type Address,
  encodeAbiParameters,
  type Hex,
  keccak256,
  parseSignature,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

export { PIXEL_WAR_BATCH_ORDER };

export type PixelWarSignature = {
  account: Hex;
  keyId: bigint;
  rawSignature: Hex;
};

export type SubmittedPixelWarMutation<name extends string = string> = {
  name: name;
  params: Record<string, unknown>;
  signature: PixelWarSignature;
};

/// Browsers hand back 65-byte secp256k1 signatures; the contract decodes
/// `abi.encode(uint8 v, bytes32 r, bytes32 s)`. P-256 signatures are already
/// abi-encoded by the signer and pass through untouched.
export function normalizeSignatureForContract(
  signature: PixelWarSignature,
): PixelWarSignature {
  if (signature.rawSignature.length !== 132) return signature;
  const { v, r, s } = parseSignature(signature.rawSignature);
  return {
    ...signature,
    rawSignature: encodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
      [Number(v), r, s],
    ),
  };
}

/// The account id for a secp256k1 signer, matching the contract's
/// `keccak256(abi.encode(address))` account derivation.
export function secp256k1AccountId(address: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }], [address]));
}

export function secp256k1PublicKey(address: Address): Hex {
  return encodeAbiParameters([{ type: "address" }], [address]);
}

/// Signs a mutation with a secp256k1 key. Used by the server for its own
/// `AdvanceEpoch` mutations and by the participant scripts.
export async function signMutation<const name extends MutationName>(input: {
  name: name;
  params: Record<string, unknown>;
  account: PrivateKeyAccount;
  signerAccountId: Hex;
  keyId: bigint;
  contract: Address;
  chainId: number;
}): Promise<SubmittedPixelWarMutation<name>> {
  const rawSignature = await input.account.signTypedData({
    domain: {
      ...TYPEWRITER_DOMAIN,
      chainId: input.chainId,
      verifyingContract: input.contract,
    },
    types: { [input.name]: EIP712_TYPES[input.name] },
    primaryType: input.name,
    message: messageFor(input.name, input.params),
    // signTypedData cannot model a primaryType chosen at runtime over a
    // multi-type schema; the payload above is valid for the chosen type.
  } as Parameters<PrivateKeyAccount["signTypedData"]>[0]);

  return {
    name: input.name,
    params: input.params,
    signature: normalizeSignatureForContract({
      account: input.signerAccountId,
      keyId: input.keyId,
      rawSignature,
    }),
  };
}

/// The bootstrap mutation for a secp256k1 account. Both key slots hold the same
/// key: slot 0 is the root key, slot 1 is what the server and scripts sign with.
export function initializeParams(address: Address): Record<string, unknown> {
  const publicKey = secp256k1PublicKey(address);
  return {
    account: secp256k1AccountId(address),
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: ALL_PERMISSIONS,
    rootPublicKey: publicKey,
    publicKey,
  };
}

export function initializeMutation(
  address: Address,
): SubmittedPixelWarMutation<"Initialize"> {
  const account = secp256k1AccountId(address);
  return {
    name: "Initialize",
    params: initializeParams(address),
    signature: { account, keyId: 0n, rawSignature: "0x" },
  };
}

/// Nonces are `(lane << 64) | seq`, so unrelated senders never queue behind each
/// other. The server keeps epoch advances on their own lane.
export const EPOCH_NONCE_LANE = 0n;

export function nonceFor(lane: bigint, seq: bigint): bigint {
  return (lane << 64n) | seq;
}

export { MAX_DEADLINE };
