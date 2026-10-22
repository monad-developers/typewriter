import type { AbiParameter, AbiParameterToPrimitiveType } from "abitype";
import {
  AbiParameters,
  Address,
  Hash,
  Hex,
  Signature as OxSignature,
  TypedData,
} from "ox";
import type { TypewriterManifest } from "./config";
import type {
  AddCredentialParams,
  Authorization,
  CreateAccountParams,
  RemoveCredentialParams,
} from "./types";
import {
  AUTHORIZATION_ABI_PARAMS,
  AUTHORIZATION_EIP712_TYPES,
  BUILTIN_MUTATIONS,
  KeyType,
  P256_SIGNATURE_PARAMS,
  SECP256K1_SIGNATURE_PARAMS,
  TYPEWRITER_EIP712_DOMAIN,
} from "./typewriter-constants";

export type { Authorization, CreateAccountParams };
export { AUTHORIZATION_ABI_PARAMS, BUILTIN_MUTATIONS, KeyType };

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT192 = (1n << 192n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;

type MutationName<manifest extends TypewriterManifest> =
  keyof manifest["mutations"] & string;

type MutationParams<
  manifest extends TypewriterManifest,
  name extends MutationName<manifest>,
> = {
  [param in manifest["mutations"][name]["params"][number] as param extends {
    name: infer paramName extends string;
  }
    ? paramName
    : never]: param extends AbiParameter
    ? AbiParameterToPrimitiveType<param>
    : never;
};

type MutationParamsForName<
  manifest extends TypewriterManifest,
  name extends MutationName<manifest>,
> = name extends "CreateAccount"
  ? CreateAccountParams
  : name extends "AddCredential"
    ? AddCredentialParams
    : name extends "RemoveCredential"
      ? RemoveCredentialParams
      : MutationParams<manifest, name>;

export type TypedMutation<
  manifest extends TypewriterManifest,
  name extends MutationName<manifest> = MutationName<manifest>,
> = {
  name: name;
  params: MutationParamsForName<manifest, name>;
  accountID: Hex.Hex;
  credentialID: bigint;
  nonce: bigint;
  expiration: bigint;
};

export type AuthorizedMutation<
  manifest extends TypewriterManifest,
  name extends MutationName<manifest> = MutationName<manifest>,
> = {
  name: name;
  params: MutationParamsForName<manifest, name>;
  authorization: Authorization;
};

export function deriveAccountID(params: CreateAccountParams): Hex.Hex {
  return Hash.keccak256(
    AbiParameters.encode(BUILTIN_MUTATIONS.CreateAccount.params, [
      params.keyType,
      params.publicKey,
    ]),
  );
}

/**
 * Returns the key that identifies one deployment of a Typewriter app. The
 * runtime uses it in the Postgres schema name, and clients use it to scope
 * browser storage.
 */
export function deploymentKey(
  chainId: number,
  address: Address.Address,
): string {
  if (!Number.isSafeInteger(chainId) || chainId < 0) {
    throw new Error(`Invalid chain id: ${chainId}`);
  }
  Address.assert(address, { strict: false });
  return `${chainId}_${address.toLowerCase()}`;
}

export function incrementNonce(nonce: bigint): bigint {
  if (nonce < 0n || nonce > MAX_UINT256) {
    throw new RangeError("nonce must fit uint256");
  }
  if ((nonce & MAX_UINT64) === MAX_UINT64) {
    throw new RangeError("nonce cannot be incremented");
  }
  return nonce + 1n;
}

export function packNonce(lane: bigint, sequence: bigint): bigint {
  if (lane < 0n || lane > MAX_UINT192) {
    throw new RangeError("nonce lane must fit uint192");
  }
  if (sequence < 0n || sequence > MAX_UINT64) {
    throw new RangeError("nonce sequence must fit uint64");
  }
  return (lane << 64n) | sequence;
}

function encodeMutationData(
  params: readonly AbiParameter[],
  value: unknown,
): Hex.Hex {
  return AbiParameters.encode(
    [{ name: "value", type: "tuple", components: params }],
    [value] as never,
  );
}

export function getAuthorizationPayload<
  const manifest extends TypewriterManifest,
  const name extends MutationName<manifest>,
>(manifest: manifest, mutation: TypedMutation<manifest, name>): Hex.Hex {
  const config = manifest.mutations[mutation.name];
  if (config === undefined)
    throw new Error(`unknown mutation: ${mutation.name}`);
  const mutationData = encodeMutationData(config.params, mutation.params);
  return TypedData.getSignPayload({
    domain: {
      ...TYPEWRITER_EIP712_DOMAIN,
      chainId: manifest.chainId,
      verifyingContract: manifest.address,
    },
    types: AUTHORIZATION_EIP712_TYPES,
    primaryType: "Authorization",
    message: {
      accountID: mutation.accountID,
      credentialID: mutation.credentialID,
      nonce: mutation.nonce,
      // ox types `uint40` as a number.
      expiration: Number(mutation.expiration),
      mutation: config.id,
      mutationData,
    },
  });
}

export function authorizeMutation<
  const manifest extends TypewriterManifest,
  const name extends MutationName<manifest>,
>(
  mutation: TypedMutation<manifest, name>,
  signature: Hex.Hex,
): AuthorizedMutation<manifest, name> {
  if (!Hex.validate(signature, { strict: true })) {
    throw new Error("signature must be protocol-encoded hex bytes");
  }
  return {
    name: mutation.name,
    params: mutation.params,
    authorization: {
      accountID: mutation.accountID,
      credentialID: mutation.credentialID,
      nonce: mutation.nonce,
      expiration: mutation.expiration,
      signature,
    },
  };
}

const P256_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export function packP256Signature(signature: Hex.Hex): Hex.Hex {
  assertSignatureSize(signature, 64, "P256");
  const r = BigInt(Hex.slice(signature, 0, 32));
  const s = BigInt(Hex.slice(signature, 32, 64));
  return AbiParameters.encode(P256_SIGNATURE_PARAMS, [
    r,
    s > P256_N / 2n ? P256_N - s : s,
  ]);
}

export function packSecp256k1Signature(signature: Hex.Hex): Hex.Hex {
  assertSignatureSize(signature, 65, "secp256k1");
  const v = Number(BigInt(Hex.slice(signature, 64, 65)));
  return AbiParameters.encode(SECP256K1_SIGNATURE_PARAMS, [
    OxSignature.vToYParity(v) + 27,
    Hex.slice(signature, 0, 32),
    Hex.slice(signature, 32, 64),
  ]);
}

function assertSignatureSize(
  signature: Hex.Hex,
  expected: number,
  name: string,
): void {
  if (
    !Hex.validate(signature, { strict: true }) ||
    Hex.size(signature) !== expected
  ) {
    throw new Error(`${name} signature must be ${expected} bytes`);
  }
}
