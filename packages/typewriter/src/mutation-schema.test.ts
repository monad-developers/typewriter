import { expect, expectTypeOf, test } from "bun:test";
import { Schema } from "effect";
import type { AbiParameters } from "ox";
import { encodeMutationCalldata } from "./encoding";
import { executeInputSchema, mutationNameGuard } from "./mutation-schema";
import { BUILTIN_MUTATIONS } from "./typewriter-constants";
import type {
  TypewriterMutation,
  TypewriterMutationInput,
} from "./typewriter-types";

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
  { name: "amount", type: "uint256" },
  { name: "flag", type: "bool" },
];
const TYPED_PARAMS = {
  memo: "memo",
  data: "0xff",
  tag: "0xabcd",
  to: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  pair: ["0x", "0x01"],
  small: 7n,
  signed: -128,
  amount: 1_000_000n,
  flag: true,
};

const MAX_UINT256 = (1n << 256n) - 1n;

function validate(
  params: unknown,
  authorization: unknown = AUTHORIZATION,
  abi: readonly AbiParameters.Parameter[] = TYPED,
) {
  return Schema.decodeUnknownSync(executeInputSchema("App", abi))({
    params,
    authorization,
  });
}

test("accepts only the names of the mutations", () => {
  const isMutationName = mutationNameGuard(["Transfer", "CreateAccount"]);
  expect(isMutationName("Transfer")).toBe(true);
  expect(isMutationName("CreateAccount")).toBe(true);
  for (const name of [
    "F",
    "",
    "transfer",
    "createAccount",
    "toString",
    "constructor",
    "__proto__",
    "hasOwnProperty",
    "valueOf",
    undefined,
    7,
  ]) {
    expect(isMutationName(name)).toBe(false);
  }
});

test("accepts any-case addresses, empty bytes, and coercible integers", () => {
  expect(() => validate(TYPED_PARAMS)).not.toThrow();
  for (const small of [7n, 7, "7", "0x07", "255"]) {
    expect(() => validate({ ...TYPED_PARAMS, small })).not.toThrow();
  }
});

test("decodes integers to bigints", () => {
  const decoded = validate(
    { ...TYPED_PARAMS, small: "0x07", signed: -128, amount: "1000000" },
    { ...AUTHORIZATION, credentialID: 7, nonce: "11", expiration: "0" },
  );
  expect(decoded.params).toMatchObject({
    small: 7n,
    signed: -128n,
    amount: 1_000_000n,
  });
  expect(decoded.authorization).toMatchObject({
    credentialID: 7n,
    nonce: 11n,
    expiration: 0n,
  });
});

test("accepted params encode to the bytes of the canonical params", () => {
  const encode = (params: unknown) => {
    validate(params);
    return encodeMutationCalldata({
      config: { id: 0, params: TYPED },
      params,
      authorization: AUTHORIZATION,
    } as Parameters<typeof encodeMutationCalldata>[0]);
  };
  const canonical = encode(TYPED_PARAMS);
  for (const params of [
    { ...TYPED_PARAMS, small: "7", signed: "-128", amount: "1000000" },
    { ...TYPED_PARAMS, small: "0x07", amount: "0xf4240" },
    { ...TYPED_PARAMS, small: 7, amount: 1_000_000 },
    { ...TYPED_PARAMS, to: TYPED_PARAMS.to.toLowerCase(), data: "0xFF" },
    {
      ...TYPED_PARAMS,
      extra: 1n,
      execution_index: 123n,
      authorization_nonce: 123n,
      block_number: 123n,
    },
  ]) {
    expect(encode(params)).toBe(canonical);
  }
});

test.each([
  ["a missing string", { memo: undefined }, "Expected string"],
  ["a number as a string", { memo: 7 }, "Expected string"],
  ["a string as a bool", { flag: "false" }, "Expected boolean"],
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
    "a word as an integer",
    { amount: "not a number" },
    "Expected an integer for uint256",
  ],
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
  ["a negative uint256", { amount: -1n }, "Expected uint256 between"],
  [
    "a uint256 above its range",
    { amount: MAX_UINT256 + 1n },
    "Expected uint256 between",
  ],
])("rejects %s", (_, change, message) => {
  expect(() => validate({ ...TYPED_PARAMS, ...change })).toThrow(message);
});

test("rejects params missing a field, or not an object", () => {
  const { amount: _, ...missing } = TYPED_PARAMS;
  expect(() => validate(missing)).toThrow("Missing key");
  for (const params of [
    null,
    undefined,
    "params",
    7,
    Object.values(TYPED_PARAMS),
  ]) {
    expect(() => validate(params)).toThrow();
  }
});

test("accepts any hex signature, which the contract checks", () => {
  for (const signature of ["0x", "0xdead", `0x${"ab".repeat(96)}`]) {
    expect(() =>
      validate(TYPED_PARAMS, { ...AUTHORIZATION, signature }),
    ).not.toThrow();
  }
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

test.each([
  ["accountID", "0x1234", "Expected 32 hex bytes"],
  ["accountID", `0x${"11".repeat(31)}`, "Expected 32 hex bytes"],
  ["accountID", `0x${"11".repeat(33)}`, "Expected 32 hex bytes"],
  ["accountID", "account", "Expected 32 hex bytes"],
  ["credentialID", -1n, "Expected uint64 between"],
  ["credentialID", 1n << 64n, "Expected uint64 between"],
  ["credentialID", "zero", "Expected an integer for uint64"],
  ["nonce", -11n, "Expected uint256 between"],
  ["nonce", 11n + (1n << 256n), "Expected uint256 between"],
  ["nonce", "11n", "Expected an integer for uint256"],
  ["expiration", -1n, "Expected uint40 between"],
  ["expiration", 1n << 40n, "Expected uint40 between"],
  ["expiration", "never", "Expected an integer for uint40"],
  ["credentialID", undefined, "Expected bigint | number | string"],
  ["nonce", undefined, "Expected bigint | number | string"],
  ["expiration", undefined, "Expected bigint | number | string"],
  ["signature", undefined, "Expected even-length hex bytes"],
])("rejects an authorization %s of %p", (field, value, message) => {
  expect(() =>
    validate(TYPED_PARAMS, { ...AUTHORIZATION, [field]: value }),
  ).toThrow(message);
});

test("rejects an authorization missing a field, or not an object", () => {
  for (const field of ["credentialID", "expiration", "signature"]) {
    const { [field as keyof typeof AUTHORIZATION]: _, ...authorization } =
      AUTHORIZATION;
    expect(() => validate(TYPED_PARAMS, authorization)).toThrow("Missing key");
  }
  // The encoder spreads the authorization, so it must be an object.
  expect(() => validate(TYPED_PARAMS, Object.values(AUTHORIZATION))).toThrow();
});

test("accepts nested structs as objects, and checks their fields", () => {
  const leg = [
    { name: "side", type: "uint8" },
    { name: "price", type: "uint128" },
  ];
  const nested: readonly AbiParameters.Parameter[] = [
    { name: "leg", type: "tuple", components: leg },
    { name: "legs", type: "tuple[]", components: leg },
  ];
  const encode = (params: unknown) => {
    validate(params, AUTHORIZATION, nested);
    return encodeMutationCalldata({
      config: { id: 0, params: nested },
      params,
      authorization: AUTHORIZATION,
    } as Parameters<typeof encodeMutationCalldata>[0]);
  };

  const canonical = encode({
    leg: { side: 1n, price: 100n },
    legs: [{ side: 0n, price: 5n }],
  });
  expect(
    encode({
      leg: { side: 1, price: "100" },
      legs: [{ side: 0, price: "0x05" }],
    }),
  ).toBe(canonical);

  for (const [params, message] of [
    [{ leg: { side: 256n, price: 0n }, legs: [] }, "Expected uint8 between"],
    [{ leg: { side: 0n }, legs: [] }, "Missing key"],
    [{ leg: { side: 0n, price: 0n }, legs: [{ side: 0n }] }, "Missing key"],
    [{ leg: { side: 0n, price: 0n }, legs: {} }, "Expected array"],
    [{ leg: [1n, 100n], legs: [] }, "Expected object"],
  ] as const) {
    expect(() => validate(params, AUTHORIZATION, nested)).toThrow(message);
  }
});

test("decodes built-in params, with only the protocol's key types", () => {
  const decode = (name: keyof typeof BUILTIN_MUTATIONS, params: unknown) =>
    Schema.decodeUnknownSync(
      executeInputSchema(name, BUILTIN_MUTATIONS[name].params),
    )({ params, authorization: AUTHORIZATION }).params;

  expect(
    decode("AddCredential", {
      expiration: "0",
      keyType: 2,
      permissions: 1,
      publicKey: "0x03",
    }),
  ).toEqual({ expiration: 0n, keyType: 2, permissions: 1n, publicKey: "0x03" });
  expect(decode("RemoveCredential", { credentialID: "0x01" })).toEqual({
    credentialID: 1n,
  });
  for (const keyType of [3, 2n, "2"]) {
    expect(() =>
      decode("CreateAccount", { keyType, publicKey: "0x03" }),
    ).toThrow();
  }
});

test("takes what `execute` takes, and decodes to what the runtime uses", () => {
  const MUTATIONS = {
    ...BUILTIN_MUTATIONS,
    App: {
      params: [
        { name: "small", type: "uint8" },
        { name: "amount", type: "uint256" },
        { name: "to", type: "address" },
        {
          name: "legs",
          type: "tuple[]",
          components: [{ name: "price", type: "uint128" }],
        },
      ],
    },
  } as const;
  type Codecs = {
    [name in keyof typeof MUTATIONS]: ReturnType<
      typeof executeInputSchema<name, (typeof MUTATIONS)[name]["params"]>
    >;
  };
  type Check<name extends keyof typeof MUTATIONS> = {
    encoded: Omit<TypewriterMutationInput<typeof MUTATIONS, name>, "name">;
    type: Omit<TypewriterMutation<name, (typeof MUTATIONS)[name]>, "name">;
  };

  expectTypeOf<Codecs["App"]["Encoded"]>().toEqualTypeOf<
    Check<"App">["encoded"]
  >();
  expectTypeOf<Codecs["App"]["Type"]>().toEqualTypeOf<Check<"App">["type"]>();
  expectTypeOf<Codecs["App"]["Type"]["params"]>().toEqualTypeOf<{
    small: bigint;
    amount: bigint;
    to: `0x${string}`;
    legs: readonly { price: bigint }[];
  }>();
  expectTypeOf<Codecs["AddCredential"]["Encoded"]>().toEqualTypeOf<
    Check<"AddCredential">["encoded"]
  >();
  expectTypeOf<Codecs["AddCredential"]["Type"]>().toEqualTypeOf<
    Check<"AddCredential">["type"]
  >();
});
