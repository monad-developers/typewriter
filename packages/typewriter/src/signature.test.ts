import { expect, test } from "bun:test";
import { AbiParameters, Hash, P256, PublicKey } from "ox";
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
  signSecp256k1Raw,
  signWebAuthnP256Raw,
} from "../test/utils";
import { verifySignature } from "./signature";
import { WEBAUTHN_P256_SIGNATURE_PARAMS } from "./typewriter-constants";

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
  const [authenticatorData, clientDataJSON, challengeOffset, r, s] =
    AbiParameters.decode(
      WEBAUTHN_P256_SIGNATURE_PARAMS,
      signWebAuthnP256Raw(DIGEST, P256_PRIVATE_KEY),
    );
  const signature = AbiParameters.encode(WEBAUTHN_P256_SIGNATURE_PARAMS, [
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
