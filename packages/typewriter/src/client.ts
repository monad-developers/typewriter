import type { AbiParameter, AbiParameterToPrimitiveType } from "abitype";
import { AbiParameters, Hash, Hex, TypedData } from "ox";
import type { TypewriterManifest } from "./config";
import { KeyType, packP256Signature } from "./signature";
import type {
  AddCredentialParams,
  Authorization,
  CreateAccountParams,
  RemoveCredentialParams,
} from "./types";

export { KeyType, packP256Signature };
export type { Authorization, CreateAccountParams };

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT192 = (1n << 192n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;

const AUTHORIZATION_TYPES = {
  Authorization: [
    { name: "accountID", type: "bytes32" },
    { name: "credentialID", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "mutation", type: "uint8" },
    { name: "mutationData", type: "bytes" },
  ],
} as const;

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
    AbiParameters.encode(
      [
        { name: "keyType", type: "uint8" },
        { name: "publicKey", type: "bytes" },
      ],
      [params.keyType, params.publicKey],
    ),
  );
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
      name: "Typewriter",
      version: "1",
      chainId: manifest.chainId,
      verifyingContract: manifest.address,
    },
    types: AUTHORIZATION_TYPES,
    primaryType: "Authorization",
    message: {
      accountID: mutation.accountID,
      credentialID: mutation.credentialID,
      nonce: mutation.nonce,
      expiration: mutation.expiration,
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
