import { expect, test } from "bun:test";
import {
  AbiParameters,
  Address,
  Base64,
  Bytes,
  Hash,
  Hex,
  P256,
  PublicKey,
  Secp256k1,
  Signature,
  TypedData,
  WebAuthnP256,
} from "ox";
import {
  createAccountMutation,
  createSigner,
  deriveAccountID,
  encodePermissions,
  getAuthorizationPayload,
  getAuthorizationTypedData,
  KeyType,
  type Signer,
} from "./client";
import {
  BUILTIN_MUTATIONS,
  P256_SIGNATURE_PARAMS,
  SECP256K1_PUBLIC_KEY_PARAMS,
  SECP256K1_SIGNATURE_PARAMS,
  WEBAUTHN_P256_SIGNATURE_PARAMS,
} from "./typewriter-constants";

// These checks mirror `verifySignature` in Typewriter.sol.

const manifest = {
  chainId: 10,
  address: "0x1111111111111111111111111111111111111111",
  deploymentKey: "10_0x1111111111111111111111111111111111111111",
  mutations: {
    Transfer: {
      id: 7,
      params: [
        { name: "recipient", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    ...BUILTIN_MUTATIONS,
  },
} as const;

const P256_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const ACCOUNT: Hex.Hex = `0x${"dd".repeat(32)}`;

function transfer(accountID: Hex.Hex) {
  return {
    name: "Transfer",
    params: {
      recipient: "0x2222222222222222222222222222222222222222",
      amount: 50n,
    },
    accountID,
    credentialID: 1n,
    nonce: (9n << 64n) | 4n,
    expiration: 1_900_000_000,
  } as const;
}

/** `decodeP256PublicKey`: a 65-byte uncompressed key, or ABI-encoded `(x, y)`. */
function p256PublicKey(publicKey: Hex.Hex) {
  return Hex.size(publicKey) === 65 ? publicKey : Hex.concat("0x04", publicKey);
}

/** The P256 precompile with the contract's message, plus a low-s check. */
function verifyP256(
  message: Hex.Hex,
  publicKey: Hex.Hex,
  r: bigint,
  s: bigint,
) {
  expect(s <= P256_N / 2n).toBe(true);
  return P256.verify({
    payload: message,
    publicKey: p256PublicKey(publicKey),
    signature: {
      r: Hex.fromNumber(r, { size: 32 }),
      s: Hex.fromNumber(s, { size: 32 }),
    },
  });
}

/** A P256 signer for a Web Crypto key pair, as an app writes one. */
async function webCryptoSigner(keyPair: CryptoKeyPair) {
  const publicKey = Hex.fromBytes(
    new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)),
  );
  return createSigner(manifest, {
    keyType: KeyType.P256,
    publicKey,
    async sign(payload) {
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keyPair.privateKey,
        Uint8Array.from(Bytes.fromHex(payload)),
      );
      return Signature.fromHex(Hex.fromBytes(new Uint8Array(signature)));
    },
  });
}

/** A secp256k1 signer for a private key, as an app writes one. */
function privateKeySigner(privateKey: Hex.Hex) {
  return createSigner(manifest, {
    keyType: KeyType.Secp256k1,
    address: Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey })),
    async sign(payload) {
      return Secp256k1.sign({ payload, privateKey });
    },
  });
}

test("typed data hashes to the authorization payload", () => {
  const mutation = transfer(`0x${"aa".repeat(32)}`);
  expect(
    TypedData.getSignPayload(getAuthorizationTypedData(manifest, mutation)),
  ).toBe(getAuthorizationPayload(manifest, mutation));
});

test("a Web Crypto P256 signer signs as verifyP256 checks", async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const signer = await webCryptoSigner(keyPair);
  expect(signer.keyType).toBe(KeyType.P256);

  const mutation = transfer(`0x${"aa".repeat(32)}`);
  const signed = await signer.signMutation(mutation);
  expect(signed.mutation).toBe(mutation);
  const [r, s] = AbiParameters.decode(P256_SIGNATURE_PARAMS, signed.signature);
  const payload = getAuthorizationPayload(manifest, mutation);
  expect(verifyP256(Hash.sha256(payload), signer.publicKey, r, s)).toBe(true);
  expect(verifyP256(payload, signer.publicKey, r, s)).toBe(false);
});

test("createSigner takes P256 scalars as hex or bigints and lowers a high s", async () => {
  const highS = P256_N / 2n + 1n;
  const encodings = await Promise.all(
    [
      { r: 0x11n, s: highS },
      { r: Hex.fromNumber(0x11n, { size: 32 }), s: Hex.fromNumber(highS) },
    ].map(async (signature) => {
      const signer = createSigner(manifest, {
        keyType: KeyType.P256,
        publicKey: `0x${"22".repeat(64)}`,
        sign: async () => signature,
      });
      return (await signer.signMutation(transfer(ACCOUNT))).signature;
    }),
  );
  for (const encoded of encodings) {
    expect(AbiParameters.decode(P256_SIGNATURE_PARAMS, encoded)).toEqual([
      0x11n,
      P256_N - highS,
    ]);
  }
});

test("createSigner refuses a P256 public key in another format", () => {
  const sign = async () => ({ r: 1n, s: 1n });
  for (const publicKey of [
    `0x${"22".repeat(33)}`,
    `0x03${"22".repeat(64)}`,
    "0x",
  ] as const) {
    expect(() =>
      createSigner(manifest, { keyType: KeyType.P256, publicKey, sign }),
    ).toThrow("P-256 public key");
  }
});

test("a secp256k1 signer signs the payload as ecrecover checks it", async () => {
  const signer = privateKeySigner(Secp256k1.randomPrivateKey());
  const [address] = AbiParameters.decode(
    SECP256K1_PUBLIC_KEY_PARAMS,
    signer.publicKey,
  );

  const mutation = transfer(`0x${"bb".repeat(32)}`);
  const signed = await signer.signMutation(mutation);
  const [v, r, s] = AbiParameters.decode(
    SECP256K1_SIGNATURE_PARAMS,
    signed.signature,
  );
  expect([27, 28]).toContain(v);
  expect(
    Secp256k1.recoverAddress({
      payload: getAuthorizationPayload(manifest, mutation),
      signature: { r, s, yParity: v - 27 },
    }).toLowerCase(),
  ).toBe(address.toLowerCase());
});

test("createSigner takes a secp256k1 yParity or v", async () => {
  const sign = async (yParity: number) => {
    const signer = createSigner(manifest, {
      keyType: KeyType.Secp256k1,
      address: "0x3333333333333333333333333333333333333333",
      sign: async () => ({ r: 1n, s: 2n, yParity }),
    });
    return (await signer.signMutation(transfer(ACCOUNT))).signature;
  };
  const v = async (yParity: number) =>
    AbiParameters.decode(SECP256K1_SIGNATURE_PARAMS, await sign(yParity))[0];

  expect(await v(0)).toBe(27);
  expect(await v(1)).toBe(28);
  expect(await v(27)).toBe(27);
  expect(await v(28)).toBe(28);
  await expect(sign(2)).rejects.toThrow("yParity");
});

/** A DER-encoded ECDSA signature, as an authenticator returns it. */
function derSignature(r: Hex.Hex, s: Hex.Hex): Uint8Array {
  const integer = (value: Hex.Hex) => {
    let bytes = Bytes.fromHex(value);
    while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1);
    if ((bytes[0] ?? 0) & 0x80)
      bytes = Bytes.concat(new Uint8Array([0]), bytes);
    return Bytes.concat(new Uint8Array([0x02, bytes.length]), bytes);
  };
  const body = Bytes.concat(integer(r), integer(s));
  return Bytes.concat(new Uint8Array([0x30, body.length]), body);
}

/** An authenticator for `privateKey`, standing in for `navigator.credentials.get`. */
function authenticator(privateKey: Hex.Hex) {
  const authenticatorData = Hex.concat(
    Hex.padLeft("0x0", 32),
    "0x05",
    "0x00000000",
  );
  return async (options: unknown) => {
    const { challenge } = (options as { publicKey: { challenge: Uint8Array } })
      .publicKey;
    const clientDataJSON = JSON.stringify({
      type: "webauthn.get",
      challenge: Base64.fromBytes(challenge, { url: true, pad: false }),
      origin: "https://example.test",
      crossOrigin: false,
    });
    const message = Hash.sha256(
      Hex.concat(
        authenticatorData,
        Hash.sha256(Hex.fromString(clientDataJSON)),
      ),
    );
    const { r, s } = P256.sign({ payload: message, privateKey });
    return {
      id: "credential",
      type: "public-key",
      response: {
        authenticatorData: Bytes.fromHex(authenticatorData).buffer,
        clientDataJSON: Bytes.fromString(clientDataJSON).buffer,
        signature: derSignature(r, s).buffer,
      },
    } as never;
  };
}

test("a passkey signer encodes an assertion as verifyWebAuthnP256 checks it", async () => {
  const privateKey = P256.randomPrivateKey();
  const signer = createSigner(manifest, {
    keyType: KeyType.WebAuthnP256,
    publicKey: PublicKey.toHex(P256.getPublicKey({ privateKey })),
    async sign(payload) {
      const { metadata, signature } = await WebAuthnP256.sign({
        challenge: payload,
        rpId: "example.test",
        getFn: authenticator(privateKey),
      });
      return { ...signature, ...metadata };
    },
  });
  expect(signer.keyType).toBe(KeyType.WebAuthnP256);

  const mutation = transfer(`0x${"cc".repeat(32)}`);
  const signed = await signer.signMutation(mutation);
  const [authenticatorData, clientDataJSON, challengeOffset, r, s] =
    AbiParameters.decode(WEBAUTHN_P256_SIGNATURE_PARAMS, signed.signature);

  // `verifyChallenge`: the base64url payload sits at `challengeOffset`.
  const payload = getAuthorizationPayload(manifest, mutation);
  const challenge = Base64.fromHex(payload, { url: true, pad: false });
  const offset = Number(challengeOffset);
  expect(
    Hex.toString(Hex.slice(clientDataJSON, offset, offset + challenge.length)),
  ).toBe(challenge);

  const message = Hash.sha256(
    Hex.concat(authenticatorData, Hash.sha256(clientDataJSON)),
  );
  expect(verifyP256(message, signer.publicKey, r, s)).toBe(true);
});

test("createAccountMutation derives the account from the signer", async () => {
  const signer = privateKeySigner(Secp256k1.randomPrivateKey());
  const mutation = createAccountMutation(signer);
  expect(mutation.accountID).toBe(
    deriveAccountID({ keyType: signer.keyType, publicKey: signer.publicKey }),
  );
  const signed = await signer.signMutation(mutation);
  expect(signed.mutation.params).toEqual({
    keyType: signer.keyType,
    publicKey: signer.publicKey,
  });
});

test("signMutation refuses a CreateAccount signed by another key", async () => {
  const signer = privateKeySigner(Secp256k1.randomPrivateKey());
  const other: Signer<typeof manifest> = privateKeySigner(
    Secp256k1.randomPrivateKey(),
  );
  await expect(
    other.signMutation(createAccountMutation(signer)),
  ).rejects.toThrow("CreateAccount must be signed by the key it creates");
});

function addCredential<const permissions>(permissions: permissions) {
  return {
    name: "AddCredential",
    params: {
      expiration: 0,
      keyType: KeyType.P256,
      permissions,
      publicKey: `0x04${"22".repeat(64)}`,
    },
    accountID: ACCOUNT,
    credentialID: 0n,
    nonce: 0n,
    expiration: 0,
  } as const;
}

test("signMutation encodes AddCredential permissions given as mutation names", async () => {
  const signer = privateKeySigner(Secp256k1.randomPrivateKey());
  const signed = await signer.signMutation(
    addCredential(["Transfer", "RemoveCredential"]),
  );
  const permissions = encodePermissions(manifest, [
    "Transfer",
    "RemoveCredential",
  ]);
  expect(signed.mutation.params.permissions).toBe(permissions);

  // The signature covers the encoded value, so it verifies as signed.
  const [v, r, s] = AbiParameters.decode(
    SECP256K1_SIGNATURE_PARAMS,
    signed.signature,
  );
  const [address] = AbiParameters.decode(
    SECP256K1_PUBLIC_KEY_PARAMS,
    signer.publicKey,
  );
  expect(
    Secp256k1.recoverAddress({
      payload: getAuthorizationPayload(manifest, addCredential(permissions)),
      signature: { r, s, yParity: v - 27 },
    }).toLowerCase(),
  ).toBe(address.toLowerCase());

  await expect(
    // @ts-expect-error Permissions name the manifest's mutations.
    signer.signMutation(addCredential(["Mint"])),
  ).rejects.toThrow("unknown mutation: Mint");
});

test("signMutation passes AddCredential permissions given as a bigint through", async () => {
  const signer = privateKeySigner(Secp256k1.randomPrivateKey());
  const mutation = addCredential(1n << 7n);
  const signed = await signer.signMutation(mutation);
  expect(signed.mutation).toBe(mutation);
});
