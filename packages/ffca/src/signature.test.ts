import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import { AbiParameters, Hash, Hex, P256, PublicKey, Secp256k1 } from "ox";
import {
  BOB_ACCOUNT,
  P256_PRIVATE_KEY,
  USER_ACCOUNT,
  USER_PRIVATE_KEY,
} from "../test/setup";
import {
  p256PublicKey,
  secp256k1PublicKey,
  signP256Raw,
  signWebAuthnP256Raw,
} from "../test/utils";
import { verifySignature } from "./signature";

const DIGEST = Hash.keccak256("0x1234");

test("verifySignature accepts secp256k1 signatures", () => {
  const signature = signSecp256k1Raw(DIGEST, USER_PRIVATE_KEY);

  expect(() =>
    verifySignature(
      2,
      DIGEST,
      secp256k1PublicKey(USER_ACCOUNT.address),
      signature,
    ),
  ).not.toThrow();
});

test("verifySignature rejects secp256k1 signatures for the wrong public key", () => {
  const signature = signSecp256k1Raw(DIGEST, USER_PRIVATE_KEY);

  expect(() =>
    verifySignature(
      2,
      DIGEST,
      secp256k1PublicKey(BOB_ACCOUNT.address),
      signature,
    ),
  ).toThrow(/InvalidSignature: keyType=2/);
});

test("verifySignature accepts P256 signatures", () => {
  const signature = signP256Raw(DIGEST, P256_PRIVATE_KEY);

  expect(() =>
    verifySignature(0, DIGEST, p256PublicKey(P256_PRIVATE_KEY), signature),
  ).not.toThrow();
});

test("verifySignature accepts uncompressed P256 public keys", () => {
  const signature = signP256Raw(DIGEST, P256_PRIVATE_KEY);
  const publicKey = PublicKey.toHex(
    P256.getPublicKey({ privateKey: P256_PRIVATE_KEY }),
  );

  expect(() => verifySignature(0, DIGEST, publicKey, signature)).not.toThrow();
});

test("verifySignature rejects P256 signatures for the wrong digest", () => {
  const signature = signP256Raw(DIGEST, P256_PRIVATE_KEY);

  expect(() =>
    verifySignature(
      0,
      Hash.keccak256("0x5678"),
      p256PublicKey(P256_PRIVATE_KEY),
      signature,
    ),
  ).toThrow(/InvalidSignature: keyType=0/);
});

test("verifySignature accepts WebAuthn-P256 signatures", () => {
  const signature = signWebAuthnP256Raw(DIGEST, P256_PRIVATE_KEY);

  expect(() =>
    verifySignature(1, DIGEST, p256PublicKey(P256_PRIVATE_KEY), signature),
  ).not.toThrow();
});

test("verifySignature rejects WebAuthn-P256 signatures with the wrong challenge offset", () => {
  const params = parseAbiParameters(
    "bytes authenticatorData, bytes clientDataJSON, uint256 challengeOffset, uint256 r, uint256 s",
  );
  const [authenticatorData, clientDataJSON, challengeOffset, r, s] =
    AbiParameters.decode(
      params,
      signWebAuthnP256Raw(DIGEST, P256_PRIVATE_KEY),
    ) as readonly [Hex.Hex, Hex.Hex, bigint, bigint, bigint];
  const signature = AbiParameters.encode(params, [
    authenticatorData,
    clientDataJSON,
    challengeOffset + 1n,
    r,
    s,
  ]);

  expect(() =>
    verifySignature(1, DIGEST, p256PublicKey(P256_PRIVATE_KEY), signature),
  ).toThrow(/InvalidSignature: keyType=1/);
});

test("verifySignature rejects unknown key types", () => {
  expect(() => verifySignature(3, DIGEST, "0x", "0x")).toThrow(
    /InvalidSignature: keyType=3/,
  );
});

function signSecp256k1Raw(digest: Hex.Hex, privateKey: Hex.Hex): Hex.Hex {
  const signature = Secp256k1.sign({ payload: digest, privateKey });
  return AbiParameters.encode(
    parseAbiParameters("uint8 v, bytes32 r, bytes32 s"),
    [
      signature.yParity + 27,
      Hex.fromNumber(signature.r, { size: 32 }),
      Hex.fromNumber(signature.s, { size: 32 }),
    ],
  );
}
