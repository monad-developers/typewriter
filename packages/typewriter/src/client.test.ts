import { expect, test } from "bun:test";
import { AbiParameters, Hex } from "ox";
import {
  authorizeMutation,
  deriveAccountID,
  getAuthorizationPayload,
  incrementNonce,
  KeyType,
  packNonce,
  packP256Signature,
} from "./client";

const manifest = {
  chainId: 10,
  address: "0x1111111111111111111111111111111111111111",
  mutations: {
    Transfer: {
      id: 7,
      params: [
        { name: "recipient", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    CreateAccount: {
      id: 253,
      params: [
        { name: "keyType", type: "uint8" },
        { name: "publicKey", type: "bytes" },
      ],
    },
    AddCredential: {
      id: 254,
      params: [
        { name: "expiration", type: "uint40" },
        { name: "keyType", type: "uint8" },
        { name: "permissions", type: "uint256" },
        { name: "publicKey", type: "bytes" },
      ],
    },
    RemoveCredential: {
      id: 255,
      params: [{ name: "credentialID", type: "uint64" }],
    },
  },
} as const;

test("signs a generic authorization over the exact mutation calldata encoding", async () => {
  const mutation = {
    name: "Transfer",
    params: {
      recipient: "0x2222222222222222222222222222222222222222",
      amount: 50n,
    },
    accountID:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    credentialID: 3n,
    nonce: (9n << 64n) | 4n,
    expiration: 1_900_000_000n,
  } as const;
  const payload = getAuthorizationPayload(manifest, mutation);
  const prepared = authorizeMutation(mutation, "0x1234");

  expect(payload).toBe(
    "0x1b9eef7b369e28b2ea0b382634167ab48f5890b6319ca8bf8ab4ed705c98e958",
  );
  expect(prepared).toEqual({
    name: "Transfer",
    params: {
      recipient: "0x2222222222222222222222222222222222222222",
      amount: 50n,
    },
    authorization: {
      accountID:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      credentialID: 3n,
      nonce: (9n << 64n) | 4n,
      expiration: 1_900_000_000n,
      signature: "0x1234",
    },
  });
});

test("signs CreateAccount calldata with the derived accountID", async () => {
  const params = { keyType: KeyType.P256, publicKey: "0x01020304" } as const;
  const accountID = deriveAccountID(params);
  const mutation = {
    name: "CreateAccount",
    params,
    accountID,
    credentialID: 0n,
    nonce: 0n,
    expiration: 0n,
  } as const;
  const payload = getAuthorizationPayload(manifest, mutation);
  const prepared = authorizeMutation(mutation, "0xabcd");

  expect(deriveAccountID(params)).toBe(
    "0xd690045981ca381a50cc9ecab2e603d4ee6a72cd6f39a8c6525464851ddfaafe",
  );
  expect(payload).toBe(
    "0x78ee499a8d098e18f91fe87b88a8012324ad1c54e119dc1b93815674e0f3d4fe",
  );
  expect(prepared.authorization).toEqual({
    accountID:
      "0xd690045981ca381a50cc9ecab2e603d4ee6a72cd6f39a8c6525464851ddfaafe",
    credentialID: 0n,
    nonce: 0n,
    expiration: 0n,
    signature: "0xabcd",
  });
});

test("increments nonces with uint bounds", () => {
  expect(incrementNonce(0n)).toBe(1n);
  expect(incrementNonce(9n << 64n)).toBe((9n << 64n) | 1n);
  expect(incrementNonce((1n << 256n) - 2n)).toBe((1n << 256n) - 1n);
  expect(() => incrementNonce((9n << 64n) | ((1n << 64n) - 1n))).toThrow(
    /cannot be incremented/,
  );
  expect(() => incrementNonce(-1n)).toThrow(/nonce must fit uint256/);
  expect(() => incrementNonce(1n << 256n)).toThrow(/nonce must fit uint256/);
  expect(() => incrementNonce((1n << 256n) - 1n)).toThrow(
    /cannot be incremented/,
  );
});

test("packs bounded parallel nonce lanes", () => {
  expect(packNonce(9n, 4n)).toBe((9n << 64n) | 4n);
  expect(packNonce((1n << 192n) - 1n, (1n << 64n) - 1n)).toBe(
    (1n << 256n) - 1n,
  );
  expect(() => packNonce(-1n, 0n)).toThrow(/lane must fit uint192/);
  expect(() => packNonce(1n << 192n, 0n)).toThrow(/lane must fit uint192/);
  expect(() => packNonce(0n, -1n)).toThrow(/sequence must fit uint64/);
  expect(() => packNonce(0n, 1n << 64n)).toThrow(/sequence must fit uint64/);
});

test("exposes protocol key types and packs raw signatures", () => {
  expect(KeyType).toEqual({ P256: 0, WebAuthnP256: 1, Secp256k1: 2 });

  const p256Raw = `0x${"11".repeat(32)}${"22".repeat(32)}` as const;
  expect(
    AbiParameters.decode(
      [
        { name: "r", type: "uint256" },
        { name: "s", type: "uint256" },
      ],
      packP256Signature(p256Raw),
    ),
  ).toEqual([BigInt(`0x${"11".repeat(32)}`), BigInt(`0x${"22".repeat(32)}`)]);

  expect(() => packP256Signature(Hex.fromNumber(1))).toThrow(/64 bytes/);
});

test("normalizes high-s P256 signatures when packing", () => {
  const p256N =
    0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const highS = Hex.fromNumber(p256N / 2n + 1n, { size: 32 });
  const raw = Hex.concat(`0x${"11".repeat(32)}`, highS);

  expect(
    AbiParameters.decode(
      [
        { name: "r", type: "uint256" },
        { name: "s", type: "uint256" },
      ],
      packP256Signature(raw),
    ),
  ).toEqual([BigInt(`0x${"11".repeat(32)}`), p256N - (p256N / 2n + 1n)]);
});
