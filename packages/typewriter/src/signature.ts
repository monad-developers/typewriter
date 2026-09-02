import { parseAbiParameters } from "abitype";
import {
  AbiParameters,
  Hash,
  Hex,
  Signature as OxSignature,
  P256,
  Secp256k1,
} from "ox";

export const KeyType = {
  P256: 0,
  WebAuthnP256: 1,
  Secp256k1: 2,
} as const;

export type KeyType = (typeof KeyType)[keyof typeof KeyType];

const P256_SIGNATURE_PARAMS = parseAbiParameters("uint256 r, uint256 s");
const SECP256K1_SIGNATURE_PARAMS = parseAbiParameters(
  "uint8 v, bytes32 r, bytes32 s",
);
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
  if (keyType === 0) {
    verifyP256(digest, publicKey, signature);
  } else if (keyType === 1) {
    verifyWebAuthnP256(digest, publicKey, signature);
  } else if (keyType === 2) {
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
    parseAbiParameters("address"),
    publicKey,
  ) as readonly [string];
  const [v, r, s] = AbiParameters.decode(
    parseAbiParameters("uint8 v, bytes32 r, bytes32 s"),
    signature,
  ) as readonly [number, Hex.Hex, Hex.Hex];

  const recovered = Secp256k1.recoverAddress({
    payload: digest,
    signature: OxSignature.from({
      r: BigInt(r),
      s: BigInt(s),
      yParity: OxSignature.vToYParity(v),
    }),
  });
  if (recovered.toLowerCase() !== expected.toLowerCase()) {
    throw invalidSignature(2);
  }
}

function verifyP256(
  digest: Hex.Hex,
  publicKey: Hex.Hex,
  signature: Hex.Hex,
): void {
  const { x, y } = decodeP256PublicKey(publicKey);
  const [r, s] = AbiParameters.decode(
    parseAbiParameters("uint256 r, uint256 s"),
    signature,
  ) as readonly [bigint, bigint];

  const ok = P256.verify({
    payload: digest,
    publicKey: { prefix: 4, x, y },
    signature: { r, s },
    hash: true,
  });
  if (!ok) throw invalidSignature(0);
}

function verifyWebAuthnP256(
  digest: Hex.Hex,
  publicKey: Hex.Hex,
  signature: Hex.Hex,
): void {
  const { x, y } = decodeP256PublicKey(publicKey);
  const [authenticatorData, clientDataJSON, challengeOffset, r, s] =
    AbiParameters.decode(
      parseAbiParameters(
        "bytes authenticatorData, bytes clientDataJSON, uint256 challengeOffset, uint256 r, uint256 s",
      ),
      signature,
    ) as readonly [Hex.Hex, Hex.Hex, bigint, bigint, bigint];

  verifyChallenge(clientDataJSON, Number(challengeOffset), digest);

  const message = Hash.sha256(
    Hex.concat(authenticatorData, Hash.sha256(clientDataJSON)),
  );
  const ok = P256.verify({
    payload: message,
    publicKey: { prefix: 4, x, y },
    signature: { r, s },
  });
  if (!ok) throw invalidSignature(1);
}

function decodeP256PublicKey(publicKey: Hex.Hex): { x: bigint; y: bigint } {
  if (Hex.size(publicKey) === 65) {
    return {
      x: BigInt(Hex.slice(publicKey, 1, 33)),
      y: BigInt(Hex.slice(publicKey, 33, 65)),
    };
  }

  const [x, y] = AbiParameters.decode(
    parseAbiParameters("uint256 x, uint256 y"),
    publicKey,
  ) as readonly [bigint, bigint];
  return { x, y };
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

  if (digestBytes.length !== 32) throw invalidSignature(1);
  if (offset + 43 > clientData.length) throw invalidSignature(1);

  for (let i = 0; i < 32; ) {
    const a = digestBytes[i++]!;
    const b = i < 32 ? digestBytes[i++]! : 0;
    const c = i < 32 ? digestBytes[i++]! : 0;
    const triple = (a << 16) | (b << 8) | c;

    if (clientData[offset++] !== table[(triple >> 18) & 0x3f]!) {
      throw invalidSignature(1);
    }
    if (clientData[offset++] !== table[(triple >> 12) & 0x3f]!) {
      throw invalidSignature(1);
    }
    if (clientData[offset++] !== table[(triple >> 6) & 0x3f]!) {
      throw invalidSignature(1);
    }
    if (i < 32 && clientData[offset++] !== table[triple & 0x3f]!) {
      throw invalidSignature(1);
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
