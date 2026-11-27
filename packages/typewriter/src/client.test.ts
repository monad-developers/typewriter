import { expect, test } from "bun:test";
import {
  decodePermissions,
  deriveAccountID,
  encodePermissions,
  getAuthorizationPayload,
  incrementNonce,
  KeyType,
  packNonce,
} from "./client";
import { BUILTIN_MUTATIONS } from "./typewriter-constants";

const manifest = {
  chainId: 10,
  address: "0x1111111111111111111111111111111111111111",
  deployment: "app_1",
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
    expiration: 1_900_000_000,
  } as const;
  const payload = getAuthorizationPayload(manifest, mutation);

  expect(payload).toBe(
    "0xe8f5c72c30afd05fc50d2abd8a2ea99004bddc737a74e5d3c98f3d19cb9155a9",
  );
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
    expiration: 0,
  } as const;
  const payload = getAuthorizationPayload(manifest, mutation);

  expect(deriveAccountID(params)).toBe(
    "0xd690045981ca381a50cc9ecab2e603d4ee6a72cd6f39a8c6525464851ddfaafe",
  );
  expect(payload).toBe(
    "0x35bfe6638271883c23fe96c9209a967a351c2ab942f0b5c725cdc37ca978960c",
  );
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

test("exposes protocol key types", () => {
  expect(KeyType).toEqual({ P256: 0, WebAuthnP256: 1, Secp256k1: 2 });
});

test("encodes permissions from mutation names by their manifest IDs", () => {
  expect(encodePermissions(manifest, [])).toBe(0n);
  expect(encodePermissions(manifest, ["Transfer"])).toBe(1n << 7n);
  expect(encodePermissions(manifest, ["Transfer", "RemoveCredential"])).toBe(
    (1n << 7n) | (1n << 255n),
  );
  expect(encodePermissions(manifest, ["Transfer", "Transfer"])).toBe(1n << 7n);
  expect(() => encodePermissions(manifest, ["Mint" as "Transfer"])).toThrow(
    "unknown mutation: Mint",
  );
  expect(() => encodePermissions(manifest, ["toString" as "Transfer"])).toThrow(
    "unknown mutation: toString",
  );
});

test("decodes permissions to mutation names ordered by ID", () => {
  expect(decodePermissions(manifest, 0n)).toEqual([]);
  expect(decodePermissions(manifest, (1n << 255n) | (1n << 7n))).toEqual([
    "Transfer",
    "RemoveCredential",
  ]);
  expect(decodePermissions(manifest, (1n << 256n) - 1n)).toEqual([
    "Transfer",
    "CreateAccount",
    "AddCredential",
    "RemoveCredential",
  ]);
  // Bit 0 matches no mutation in the manifest.
  expect(decodePermissions(manifest, 1n)).toEqual([]);
  expect(() => decodePermissions(manifest, -1n)).toThrow(RangeError);
  expect(() => decodePermissions(manifest, 1n << 256n)).toThrow(RangeError);
});
