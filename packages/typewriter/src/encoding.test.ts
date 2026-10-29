import { expect, test } from "bun:test";
import { AbiParameters } from "ox";
import { encodeFunctionData } from "viem";
import {
  decodeAuthorizationCalldata,
  decodeMutationCalldata,
  encodeAuthorizationCalldata,
  encodeBatchArg,
  encodeEnqueueCalldata,
  encodeExecuteCalldata,
  encodeMutationCalldata,
} from "./encoding";
import {
  AUTHORIZATION_ABI_PARAMS,
  TYPEWRITER_ABI,
} from "./typewriter-constants";
import type { Authorization, RuntimeMutation } from "./typewriter-types";

function calldataStructParams(
  params: readonly AbiParameters.Parameter[],
): readonly AbiParameters.Parameter[] {
  return [{ type: "tuple", components: params as AbiParameters.Parameter[] }];
}

const AUTHORIZATION = {
  accountID:
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  credentialID: 7n,
  nonce: 11n,
  expiration: 1_900_000_000n,
  signature: "0xdeadbeef",
} as const satisfies Authorization;

function encodable(config: RuntimeMutation["config"], params: unknown) {
  return { config, params };
}

/** A mutation with the bytes the runtime keeps for it. */
function withBytes(
  config: RuntimeMutation["config"],
  params: unknown,
  authorization: Authorization = AUTHORIZATION,
) {
  return {
    config,
    params,
    mutationData: encodeMutationCalldata({ config, params }),
    authorizationData: encodeAuthorizationCalldata(authorization),
  };
}

test("encodeMutationCalldata wraps params as one struct", () => {
  const mutation = {
    id: 0,
    params: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  };
  const params = {
    from: "0x0000000000000000000000000000000000000001",
    to: "0x0000000000000000000000000000000000000002",
    amount: 100n,
  } as const;

  const encoded = encodeMutationCalldata(encodable(mutation, params));

  expect(
    AbiParameters.decode(calldataStructParams(mutation.params), encoded),
  ).toEqual([params]);
});

test("encodeMutationCalldata wraps dynamic params as one struct", () => {
  const mutation = {
    id: 0,
    params: [
      { name: "account", type: "bytes32" },
      { name: "publicKey", type: "bytes" },
    ],
  };
  const params = {
    account:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    publicKey: "0x1234",
  } as const;

  const encoded = encodeMutationCalldata(encodable(mutation, params));

  expect(
    AbiParameters.decode(calldataStructParams(mutation.params), encoded),
  ).toEqual([params]);
});

const TYPED = {
  id: 0,
  params: [
    { name: "memo", type: "string" },
    { name: "data", type: "bytes" },
    { name: "tag", type: "bytes2" },
    { name: "to", type: "address" },
    { name: "pair", type: "bytes[2]" },
  ],
};
const TYPED_PARAMS = {
  memo: "memo",
  data: "0xff",
  tag: "0xabcd",
  to: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  pair: ["0x", "0x01"],
};

test("encodeMutationCalldata accepts any-case addresses and empty bytes", () => {
  expect(() =>
    encodeMutationCalldata(encodable(TYPED, TYPED_PARAMS)),
  ).not.toThrow();
});

test.each([
  ["a missing string", { memo: undefined }, "params.memo must be a string"],
  ["a number as a string", { memo: 7 }, "params.memo must be a string"],
  [
    "non-hex bytes",
    { data: "not hex" },
    "params.data must be even-length hex bytes",
  ],
  [
    "odd-length bytes",
    { data: "0xabc" },
    "params.data must be even-length hex bytes",
  ],
  [
    "bytes with a 0X prefix",
    { data: "0XFF" },
    "params.data must be even-length hex bytes",
  ],
  [
    "bytes2 of the wrong size",
    { tag: "0xab" },
    "params.tag must be 2 hex bytes",
  ],
  ["an invalid address", { to: "0x1234" }, "params.to must be an address"],
  [
    "a short fixed array",
    { pair: ["0x"] },
    "params.pair must be an array of 2 bytes",
  ],
  [
    "non-hex bytes in an array",
    { pair: ["0x", "zz"] },
    "params.pair[1] must be even-length hex bytes",
  ],
])("encodeMutationCalldata rejects %s", (_, change, message) => {
  expect(() =>
    encodeMutationCalldata(encodable(TYPED, { ...TYPED_PARAMS, ...change })),
  ).toThrow(message);
});

test("encodeMutationCalldata rejects params that are not an object", () => {
  expect(() => encodeMutationCalldata(encodable(TYPED, null))).toThrow(
    "params must be an object",
  );
});

test.each([
  ["not hex", "signature"],
  ["with a non-hex character", "0xdeadbeefzz"],
  ["of odd length", "0xdeadbeef0"],
  ["with a 0X prefix", "0XDEADBEEF"],
])("encodeAuthorizationCalldata rejects a signature %s", (_, signature) => {
  expect(() =>
    encodeAuthorizationCalldata({
      ...AUTHORIZATION,
      signature: signature as Authorization["signature"],
    }),
  ).toThrow("authorization.signature must be even-length hex bytes");
});

test("encodeAuthorizationCalldata rejects an accountID of the wrong size", () => {
  expect(() =>
    encodeAuthorizationCalldata({ ...AUTHORIZATION, accountID: "0x1234" }),
  ).toThrow("authorization.accountID must be 32 hex bytes");
});

test("decodeMutationCalldata round-trips params", () => {
  const mutation = {
    id: 0,
    params: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  };
  const params = {
    from: "0x0000000000000000000000000000000000000001",
    to: "0x0000000000000000000000000000000000000002",
    amount: 100n,
  };

  const encoded = encodeMutationCalldata(encodable(mutation, params));
  const decoded = decodeMutationCalldata(mutation, encoded);

  expect(decoded.params).toEqual(params);
});

test("fixed Authorization calldata round-trips as one Solidity struct", () => {
  const encoded = encodeAuthorizationCalldata(AUTHORIZATION);

  expect(encoded).toBe(
    AbiParameters.encode(calldataStructParams(AUTHORIZATION_ABI_PARAMS), [
      AUTHORIZATION,
    ]),
  );
  expect(decodeAuthorizationCalldata(encoded)).toEqual(AUTHORIZATION);
});

test("encodeExecuteCalldata matches viem encodeFunctionData", () => {
  const batch = {
    mutations: [0],
    mutationData: ["0x1234" as `0x${string}`],
    authorizationData: ["0xaa" as `0x${string}`],
  };
  const expected = encodeFunctionData({
    abi: TYPEWRITER_ABI,
    functionName: "execute",
    args: [[batch], []],
  });
  const actual = encodeExecuteCalldata([batch], []);
  expect(actual).toBe(expected);
});

test("encodeEnqueueCalldata matches viem encodeFunctionData", () => {
  const config = {
    id: 3,
    params: [{ name: "data", type: "bytes" }],
  };
  const { mutationData, authorizationData } = withBytes(config, {
    data: "0x1234",
  });
  const expected = encodeFunctionData({
    abi: TYPEWRITER_ABI,
    functionName: "enqueue",
    args: [3, mutationData, authorizationData],
  });
  const actual = encodeEnqueueCalldata({
    mutation: 3,
    mutationData,
    authorizationData,
  });
  expect(actual).toBe(expected);
});

test("encodeBatchArg builds a structured batch value", () => {
  const transfer = {
    id: 0,
    params: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  };
  const market = {
    id: 1,
    params: [{ name: "size", type: "uint256" }],
  };
  const secondAuthorization = {
    ...AUTHORIZATION,
    accountID:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    credentialID: 8n,
    signature: "0xbeef",
  } as const satisfies Authorization;
  const transferResolved = withBytes(transfer, {
    from: "0x0000000000000000000000000000000000000001",
    to: "0x0000000000000000000000000000000000000002",
    amount: 100n,
  });
  const marketResolved = withBytes(market, { size: 10n }, secondAuthorization);

  const batch = encodeBatchArg([transferResolved, marketResolved]);

  expect(batch.mutations).toEqual([0, 1]);
  expect(batch.authorizationData).toEqual([
    encodeAuthorizationCalldata(AUTHORIZATION),
    encodeAuthorizationCalldata(secondAuthorization),
  ]);

  const [decodedTransfer] = AbiParameters.decode(
    calldataStructParams(transfer.params),
    batch.mutationData[0]!,
  );
  expect(decodedTransfer).toEqual(transferResolved.params);

  const [decodedMarket] = AbiParameters.decode(
    calldataStructParams(market.params),
    batch.mutationData[1]!,
  );
  expect(decodedMarket).toEqual(marketResolved.params);
});
