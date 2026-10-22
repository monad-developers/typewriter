import {
  AbiParameters,
  Hash,
  Hex,
  Signature as OxSignature,
  P256,
  Secp256k1,
} from "ox";
import {
  KeyType,
  P256_PUBLIC_KEY_PARAMS,
  P256_SIGNATURE_PARAMS,
  SECP256K1_PUBLIC_KEY_PARAMS,
  SECP256K1_SIGNATURE_PARAMS,
  WEBAUTHN_P256_SIGNATURE_PARAMS,
} from "./typewriter-constants";

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

export function verifySignature(
  keyType: number,
  digest: Hex.Hex,
  publicKey: Hex.Hex,
  signature: Hex.Hex,
): void {
  if (keyType === KeyType.P256) {
    verifyP256(digest, publicKey, signature);
  } else if (keyType === KeyType.WebAuthnP256) {
    verifyWebAuthnP256(digest, publicKey, signature);
  } else if (keyType === KeyType.Secp256k1) {
    verifySecp256k1(digest, publicKey, signature);
  } else {
    throw invalidSignature(keyType);
  }
}

function verifySecp256k1(
  digest: Hex.Hex,
  publicKey: Hex.Hex,
  signature: Hex.Hex,
): void {
  const [expected] = AbiParameters.decode(
    SECP256K1_PUBLIC_KEY_PARAMS,
    publicKey,
  );
  const [v, r, s] = AbiParameters.decode(SECP256K1_SIGNATURE_PARAMS, signature);

  const recovered = Secp256k1.recoverAddress({
    payload: digest,
    signature: OxSignature.from({
      r,
      s,
      yParity: OxSignature.vToYParity(v),
    }),
  });
  if (recovered.toLowerCase() !== expected.toLowerCase()) {
    throw invalidSignature(KeyType.Secp256k1);
  }
}

function verifyP256(
  digest: Hex.Hex,
  publicKey: Hex.Hex,
  signature: Hex.Hex,
): void {
  const { x, y } = decodeP256PublicKey(publicKey);
  const [r, s] = AbiParameters.decode(P256_SIGNATURE_PARAMS, signature);

  const ok = P256.verify({
    payload: digest,
    publicKey: { prefix: 4, x, y },
    signature: { r: toWord(r), s: toWord(s) },
    hash: true,
  });
  if (!ok) throw invalidSignature(KeyType.P256);
}

function verifyWebAuthnP256(
  digest: Hex.Hex,
  publicKey: Hex.Hex,
  signature: Hex.Hex,
): void {
  const { x, y } = decodeP256PublicKey(publicKey);
  const [authenticatorData, clientDataJSON, challengeOffset, r, s] =
    AbiParameters.decode(WEBAUTHN_P256_SIGNATURE_PARAMS, signature);

  verifyChallenge(clientDataJSON, Number(challengeOffset), digest);

  const message = Hash.sha256(
    Hex.concat(authenticatorData, Hash.sha256(clientDataJSON)),
  );
  const ok = P256.verify({
    payload: message,
    publicKey: { prefix: 4, x, y },
    signature: { r: toWord(r), s: toWord(s) },
  });
  if (!ok) throw invalidSignature(KeyType.WebAuthnP256);
}

function decodeP256PublicKey(publicKey: Hex.Hex): { x: Hex.Hex; y: Hex.Hex } {
  if (Hex.size(publicKey) === 65) {
    return {
      x: Hex.slice(publicKey, 1, 33),
      y: Hex.slice(publicKey, 33, 65),
    };
  }

  const [x, y] = AbiParameters.decode(P256_PUBLIC_KEY_PARAMS, publicKey);
  return { x: toWord(x), y: toWord(y) };
}

function toWord(value: bigint): Hex.Hex {
  return Hex.fromNumber(value, { size: 32 });
}

function verifyChallenge(
  clientDataJSON: Hex.Hex,
  offset: number,
  digest: Hex.Hex,
): void {
  const table = new TextEncoder().encode(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  );
  const clientData = Hex.toBytes(clientDataJSON);
  const digestBytes = Hex.toBytes(digest);

  if (digestBytes.length !== 32) {
    throw invalidSignature(KeyType.WebAuthnP256);
  }
  if (offset + 43 > clientData.length) {
    throw invalidSignature(KeyType.WebAuthnP256);
  }

  for (let i = 0; i < 32; ) {
    const a = digestBytes[i++]!;
    const b = i < 32 ? digestBytes[i++]! : 0;
    const c = i < 32 ? digestBytes[i++]! : 0;
    const triple = (a << 16) | (b << 8) | c;

    if (clientData[offset++] !== table[(triple >> 18) & 0x3f]!) {
      throw invalidSignature(KeyType.WebAuthnP256);
    }
    if (clientData[offset++] !== table[(triple >> 12) & 0x3f]!) {
      throw invalidSignature(KeyType.WebAuthnP256);
    }
    if (clientData[offset++] !== table[(triple >> 6) & 0x3f]!) {
      throw invalidSignature(KeyType.WebAuthnP256);
    }
    if (i < 32 && clientData[offset++] !== table[triple & 0x3f]!) {
      throw invalidSignature(KeyType.WebAuthnP256);
    }
  }
}

function invalidSignature(keyType: number): Error {
  return new Error(`InvalidSignature: keyType=${keyType}`);
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
