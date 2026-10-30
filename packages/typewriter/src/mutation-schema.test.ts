import { expect, test } from "bun:test";
import { Schema } from "effect";
import type { AbiParameters } from "ox";
import { executeInputSchema } from "./mutation-schema";

const AUTHORIZATION = {
  accountID:
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  credentialID: 7n,
  nonce: 11n,
  expiration: 1_900_000_000n,
  signature: "0xdeadbeef",
};

const TYPED: readonly AbiParameters.Parameter[] = [
  { name: "memo", type: "string" },
  { name: "data", type: "bytes" },
  { name: "tag", type: "bytes2" },
  { name: "to", type: "address" },
  { name: "pair", type: "bytes[2]" },
  { name: "small", type: "uint8" },
  { name: "signed", type: "int8" },
];
const TYPED_PARAMS = {
  memo: "memo",
  data: "0xff",
  tag: "0xabcd",
  to: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  pair: ["0x", "0x01"],
  small: 7n,
  signed: -128,
};

function validate(
  params: unknown,
  authorization: unknown = AUTHORIZATION,
  abi: readonly AbiParameters.Parameter[] = TYPED,
) {
  return Schema.decodeUnknownSync(executeInputSchema(abi))({
    params,
    authorization,
  });
}

test("accepts any-case addresses, empty bytes, and coercible integers", () => {
  expect(() => validate(TYPED_PARAMS)).not.toThrow();
  for (const small of [7n, 7, "7", "0x07", "255"]) {
    expect(() => validate({ ...TYPED_PARAMS, small })).not.toThrow();
  }
});

test("accepts params as a positional array, and extra params", () => {
  expect(() => validate(Object.values(TYPED_PARAMS))).not.toThrow();
  expect(() => validate({ ...TYPED_PARAMS, extra: 1n })).not.toThrow();
});

test.each([
  ["a missing string", { memo: undefined }, "Expected string"],
  ["a number as a string", { memo: 7 }, "Expected string"],
  ["non-hex bytes", { data: "not hex" }, "Expected even-length hex bytes"],
  ["odd-length bytes", { data: "0xabc" }, "Expected even-length hex bytes"],
  [
    "bytes with a 0X prefix",
    { data: "0XFF" },
    "Expected even-length hex bytes",
  ],
  ["bytes2 of the wrong size", { tag: "0xab" }, "Expected 2 hex bytes"],
  ["an invalid address", { to: "0x1234" }, "Expected an address"],
  ["a short fixed array", { pair: ["0x"] }, "length of at least 2"],
  [
    "non-hex bytes in an array",
    { pair: ["0x", "zz"] },
    "Expected even-length hex bytes",
  ],
  [
    "an empty string as an integer",
    { small: "" },
    "Expected an integer for uint8",
  ],
  ["a padded integer string", { small: " 7" }, "Expected an integer for uint8"],
  [
    "a bool as an integer",
    { small: true },
    "Expected bigint | number | string",
  ],
  ["a fraction", { small: 1.5 }, "Expected an integer for uint8"],
  ["a number past 2^53", { small: 2 ** 53 }, "Expected an integer for uint8"],
  [
    "a uint8 above its range",
    { small: 256n },
    "Expected uint8 between 0 and 255",
  ],
  ["a negative uint8", { small: -1 }, "Expected uint8 between 0 and 255"],
  [
    "an int8 below its range",
    { signed: -129n },
    "Expected int8 between -128 and 127",
  ],
])("rejects %s", (_, change, message) => {
  expect(() => validate({ ...TYPED_PARAMS, ...change })).toThrow(message);
});

test("rejects params that are not an object or array", () => {
  expect(() => validate(null)).toThrow();
  expect(() => validate("params")).toThrow();
});

test.each([
  ["not hex", "signature"],
  ["with a non-hex character", "0xdeadbeefzz"],
  ["of odd length", "0xdeadbeef0"],
  ["with a 0X prefix", "0XDEADBEEF"],
])("rejects a signature %s", (_, signature) => {
  expect(() => validate(TYPED_PARAMS, { ...AUTHORIZATION, signature })).toThrow(
    "Expected even-length hex bytes",
  );
});

test("rejects an authorization field out of shape", () => {
  expect(() =>
    validate(TYPED_PARAMS, { ...AUTHORIZATION, accountID: "0x1234" }),
  ).toThrow("Expected 32 hex bytes");
  expect(() =>
    validate(TYPED_PARAMS, { ...AUTHORIZATION, expiration: 1n << 40n }),
  ).toThrow("Expected uint40 between");
  expect(() =>
    validate(TYPED_PARAMS, { ...AUTHORIZATION, nonce: undefined }),
  ).toThrow();
  // The encoder spreads the authorization, so it must be an object.
  expect(() => validate(TYPED_PARAMS, Object.values(AUTHORIZATION))).toThrow();
});
