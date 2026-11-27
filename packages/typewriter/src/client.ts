import type { AbiParameter, AbiParameterToPrimitiveType } from "abitype";
import { AbiParameters, Address, Bytes, Hash, Hex, TypedData } from "ox";
import type { TypewriterManifest } from "./config";
import { encodeSecp256k1Signature } from "./encoding";
import {
  AUTHORIZATION_ABI_PARAMS,
  AUTHORIZATION_EIP712_TYPES,
  BUILTIN_MUTATIONS,
  KeyType,
  P256_SIGNATURE_PARAMS,
  SECP256K1_PUBLIC_KEY_PARAMS,
  TYPEWRITER_EIP712_DOMAIN,
  WEBAUTHN_P256_SIGNATURE_PARAMS,
} from "./typewriter-constants";
import type {
  AddCredentialParams,
  Authorization,
  CreateAccountParams,
  RemoveCredentialParams,
} from "./typewriter-types";

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
  expiration: number;
};

/**
 * `AddCredential`'s params as a signer takes them: `permissions` can be the
 * names of the mutations the credential may sign.
 */
type SignableParams<
  manifest extends TypewriterManifest,
  name extends MutationName<manifest>,
> =
  // A union with the typed params, so a `TypedMutation` is always signable.
  | MutationParamsForName<manifest, name>
  | (name extends "AddCredential"
      ? Omit<AddCredentialParams, "permissions"> & {
          permissions: readonly MutationName<manifest>[];
        }
      : never);

/**
 * A mutation as `signer.signMutation()` takes it. It is a `TypedMutation`,
 * except that `AddCredential`'s `permissions` can be mutation names.
 */
export type SignableMutation<
  manifest extends TypewriterManifest,
  name extends MutationName<manifest> = MutationName<manifest>,
> = {
  name: name;
  params: SignableParams<manifest, name>;
  accountID: Hex.Hex;
  credentialID: bigint;
  nonce: bigint;
  expiration: number;
};

export function deriveAccountID(params: CreateAccountParams): Hex.Hex {
  return Hash.keccak256(
    AbiParameters.encode(BUILTIN_MUTATIONS.CreateAccount.params, [
      params.keyType,
      params.publicKey,
    ]),
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

/**
 * Returns the `permissions` for `AddCredential` that allow exactly the named
 * mutations. Each mutation's bit comes from its ID in the manifest, so a
 * credential granted this way doesn't gain mutations added to the app later.
 */
export function encodePermissions<const manifest extends TypewriterManifest>(
  manifest: manifest,
  names: readonly MutationName<manifest>[],
): bigint {
  let permissions = 0n;
  for (const name of names) {
    const config = Object.hasOwn(manifest.mutations, name)
      ? manifest.mutations[name]
      : undefined;
    if (config === undefined) throw new Error(`unknown mutation: ${name}`);
    permissions |= 1n << BigInt(config.id);
  }
  return permissions;
}

/**
 * Returns the names of the manifest's mutations that `permissions` allows,
 * ordered by mutation ID. Bits that match no mutation in the manifest are
 * left out.
 */
export function decodePermissions<const manifest extends TypewriterManifest>(
  manifest: manifest,
  permissions: bigint,
): MutationName<manifest>[] {
  if (permissions < 0n || permissions > MAX_UINT256) {
    throw new RangeError("permissions must fit uint256");
  }
  return (
    Object.entries(manifest.mutations) as [
      MutationName<manifest>,
      { id: number },
    ][]
  )
    .filter(([, { id }]) => (permissions >> BigInt(id)) & 1n)
    .sort(([, a], [, b]) => a.id - b.id)
    .map(([name]) => name);
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

/**
 * The EIP-712 typed data an authorization signs. Its hash is the payload from
 * `getAuthorizationPayload`. The params are ABI-encoded into `mutationData`,
 * so a wallet shows them as bytes.
 */
export type AuthorizationTypedData = {
  domain: {
    name: typeof TYPEWRITER_EIP712_DOMAIN.name;
    version: typeof TYPEWRITER_EIP712_DOMAIN.version;
    chainId: number;
    verifyingContract: Address.Address;
  };
  types: typeof AUTHORIZATION_EIP712_TYPES;
  primaryType: "Authorization";
  message: {
    accountID: Hex.Hex;
    credentialID: bigint;
    nonce: bigint;
    expiration: number;
    mutation: number;
    mutationData: Hex.Hex;
  };
};

export function getAuthorizationTypedData<
  const manifest extends TypewriterManifest,
  const name extends MutationName<manifest>,
>(
  manifest: manifest,
  mutation: TypedMutation<manifest, name>,
): AuthorizationTypedData {
  const config = Object.hasOwn(manifest.mutations, mutation.name)
    ? manifest.mutations[mutation.name]
    : undefined;
  if (config === undefined)
    throw new Error(`unknown mutation: ${mutation.name}`);
  return {
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
      expiration: mutation.expiration,
      mutation: config.id,
      mutationData: encodeMutationData(config.params, mutation.params),
    },
  };
}

/** The 32-byte EIP-712 hash an authorization signs. */
export function getAuthorizationPayload<
  const manifest extends TypewriterManifest,
  const name extends MutationName<manifest>,
>(manifest: manifest, mutation: TypedMutation<manifest, name>): Hex.Hex {
  return TypedData.getSignPayload(
    getAuthorizationTypedData(manifest, mutation),
  );
}

/** A mutation and the signature over it, ready for `typewriter.execute()`. */
export type SignedMutation<
  manifest extends TypewriterManifest,
  name extends MutationName<manifest> = MutationName<manifest>,
> = {
  mutation: TypedMutation<manifest, name>;
  signature: Hex.Hex;
};

/** A signature scalar, as 32-byte hex or a bigint. */
type Scalar = Hex.Hex | bigint;

/**
 * A signing algorithm for `createSigner`. `sign` gets the 32-byte EIP-712
 * hash to sign and the same authorization as typed data (for wallets), and
 * returns the signature's parts as ox and viem return them. `createSigner`
 * encodes them the way the contract verifies them.
 */
export type SignerOptions =
  | {
      keyType: typeof KeyType.P256;
      /** The 65-byte uncompressed key, or its 64-byte `x ‖ y`. */
      publicKey: Hex.Hex;
      /**
       * An ECDSA P-256 signature over `sha256(payload)`, as Web Crypto's
       * `crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, payload)`
       * makes.
       */
      sign(
        payload: Hex.Hex,
        typedData: AuthorizationTypedData,
      ): Promise<{ r: Scalar; s: Scalar }>;
    }
  | {
      keyType: typeof KeyType.WebAuthnP256;
      /** The passkey's public key: 65-byte uncompressed, or 64-byte `x ‖ y`. */
      publicKey: Hex.Hex;
      /**
       * A passkey assertion whose challenge is `payload`, as ox's
       * `WebAuthnP256.sign` and viem's `WebAuthnAccount.sign` return it.
       */
      sign(
        payload: Hex.Hex,
        typedData: AuthorizationTypedData,
      ): Promise<{
        r: Scalar;
        s: Scalar;
        authenticatorData: Hex.Hex;
        clientDataJSON: string;
      }>;
    }
  | {
      keyType: typeof KeyType.Secp256k1;
      address: Address.Address;
      /**
       * A secp256k1 signature over `payload` itself, with no message prefix:
       * an account's `sign({ hash: payload })`, or a wallet's
       * `signTypedData(typedData)`. `yParity` is 0 or 1 (27 or 28 also work).
       */
      sign(
        payload: Hex.Hex,
        typedData: AuthorizationTypedData,
      ): Promise<{ r: Scalar; s: Scalar; yParity: number }>;
    };

/** A key that signs mutations for one credential of one deployment. */
export type Signer<manifest extends TypewriterManifest = TypewriterManifest> = {
  keyType: KeyType;
  /** The credential's `publicKey`, as the contract stores it. */
  publicKey: Hex.Hex;
  /**
   * Signs `mutation`. The result is ready for `typewriter.execute()`. An
   * `AddCredential`'s `permissions` given as mutation names are encoded with
   * `encodePermissions` first, and the result holds the encoded value.
   */
  signMutation<const name extends MutationName<manifest>>(
    mutation: SignableMutation<manifest, name>,
  ): Promise<SignedMutation<manifest, name>>;
};

const P256_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const CHALLENGE_PREFIX = '"challenge":"';

/**
 * A `Signer` for `manifest`'s deployment, from any signing algorithm's `sign`
 * callback.
 */
export function createSigner<const manifest extends TypewriterManifest>(
  manifest: manifest,
  options: SignerOptions,
): Signer<manifest> {
  const { keyType } = options;
  let publicKey: Hex.Hex;
  if (options.keyType === KeyType.Secp256k1) {
    Address.assert(options.address, { strict: false });
    publicKey = AbiParameters.encode(SECP256K1_PUBLIC_KEY_PARAMS, [
      options.address,
    ]);
  } else {
    publicKey = assertP256PublicKey(options.publicKey);
  }

  return {
    keyType,
    publicKey,
    async signMutation(signable) {
      const mutation = withEncodedPermissions(manifest, signable);
      if (mutation.name === "CreateAccount") {
        const params = mutation.params as CreateAccountParams;
        if (
          params.keyType !== keyType ||
          params.publicKey.toLowerCase() !== publicKey.toLowerCase()
        ) {
          throw new Error("CreateAccount must be signed by the key it creates");
        }
      }
      const typedData = getAuthorizationTypedData(manifest, mutation);
      const payload = TypedData.getSignPayload(typedData);

      switch (options.keyType) {
        case KeyType.P256: {
          const { r, s } = await options.sign(payload, typedData);
          const signature = AbiParameters.encode(P256_SIGNATURE_PARAMS, [
            BigInt(r),
            lowS(BigInt(s)),
          ]);
          return { mutation, signature };
        }
        case KeyType.WebAuthnP256: {
          const { r, s, authenticatorData, clientDataJSON } =
            await options.sign(payload, typedData);
          const index = clientDataJSON.indexOf(CHALLENGE_PREFIX);
          if (index === -1) {
            throw new Error("WebAuthn clientDataJSON has no challenge");
          }
          // The contract reads the challenge at this byte offset.
          const challengeOffset = Bytes.fromString(
            clientDataJSON.slice(0, index + CHALLENGE_PREFIX.length),
          ).length;
          const signature = AbiParameters.encode(
            WEBAUTHN_P256_SIGNATURE_PARAMS,
            [
              authenticatorData,
              Hex.fromString(clientDataJSON),
              BigInt(challengeOffset),
              BigInt(r),
              lowS(BigInt(s)),
            ],
          );
          return { mutation, signature };
        }
        case KeyType.Secp256k1: {
          const { r, s, yParity } = await options.sign(payload, typedData);
          const parity = yParity >= 27 ? yParity - 27 : yParity;
          if (parity !== 0 && parity !== 1) {
            throw new Error(`invalid secp256k1 yParity: ${yParity}`);
          }
          const signature = encodeSecp256k1Signature(
            BigInt(r),
            BigInt(s),
            parity,
          );
          return { mutation, signature };
        }
      }
    },
  };
}

/** `mutation`, with an `AddCredential`'s permission names encoded. */
function withEncodedPermissions<
  const manifest extends TypewriterManifest,
  const name extends MutationName<manifest>,
>(
  manifest: manifest,
  mutation: SignableMutation<manifest, name>,
): TypedMutation<manifest, name> {
  if (mutation.name !== "AddCredential") {
    return mutation as TypedMutation<manifest, name>;
  }
  const params = mutation.params as {
    permissions: bigint | readonly MutationName<manifest>[];
  };
  if (!Array.isArray(params.permissions)) {
    return mutation as TypedMutation<manifest, name>;
  }
  return {
    ...mutation,
    params: {
      ...params,
      permissions: encodePermissions(manifest, params.permissions),
    },
  } as TypedMutation<manifest, name>;
}

/** A P-256 `s`, or `n - s` when it is in the curve order's upper half. */
function lowS(s: bigint): bigint {
  return s > P256_N / 2n ? P256_N - s : s;
}

function assertP256PublicKey(publicKey: Hex.Hex): Hex.Hex {
  const size = Hex.validate(publicKey, { strict: true })
    ? Hex.size(publicKey)
    : 0;
  if (size !== 64 && !(size === 65 && Hex.slice(publicKey, 0, 1) === "0x04")) {
    throw new Error(
      "P-256 public key must be 65 bytes uncompressed or 64 bytes x ‖ y",
    );
  }
  return publicKey;
}

/**
 * The `CreateAccount` mutation for an account whose first credential is
 * `signer`'s key. Its `accountID` is the new account's ID.
 */
export function createAccountMutation(
  signer: Pick<Signer, "keyType" | "publicKey">,
) {
  const params = { keyType: signer.keyType, publicKey: signer.publicKey };
  return {
    name: "CreateAccount",
    params,
    accountID: deriveAccountID(params),
    credentialID: 0n,
    nonce: 0n,
    expiration: 0,
  } as const;
}
