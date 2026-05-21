import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import { AbiParameters } from "ox";
import { encodeFunctionData, toEventSelector } from "viem";
import {
  COUNTER_ABI,
  COUNTER_MUTATIONS,
  testMutationSchema,
} from "../test/utils";
import {
  decodeForceInclusionLog,
  decodeMutationCalldata,
  encodeBundleArg,
  encodeEnqueueCalldata,
  encodeExecuteCalldata,
  encodeMutationCalldata,
  encodeSignatureCalldata,
  getSignatureAbiParameters,
} from "./encoding";
import type { ResolvedMutation } from "./types";

function calldataStructParams(
  params: readonly AbiParameters.Parameter[],
): readonly AbiParameters.Parameter[] {
  return [{ type: "tuple", components: params as AbiParameters.Parameter[] }];
}

function acceptedMutation(
  config: ResolvedMutation["config"],
  args: unknown,
  resolution?: unknown,
): ResolvedMutation {
  return {
    id: 0,
    status: "accepted",
    name: "test",
    args,
    signature: { keyType: 0, rawSignature: "0x" },
    isForceInclusion: false,
    config,
    resolution,
  };
}

test("encodeMutationCalldata without resolution", () => {
  const mutation = {
    tag: 0,
    table: testMutationSchema,
    params: parseAbiParameters("address from, address to, uint256 amount"),
  };
  const args = {
    from: "0x0000000000000000000000000000000000000001",
    to: "0x0000000000000000000000000000000000000002",
    amount: 100n,
  } as const;

  const encoded = encodeMutationCalldata(acceptedMutation(mutation, args));

  expect(
    AbiParameters.decode(calldataStructParams(mutation.params), encoded),
  ).toEqual([args]);
});

test("encodeMutationCalldata wraps dynamic params as one struct", () => {
  const mutation = {
    tag: 0,
    table: testMutationSchema,
    params: parseAbiParameters("bytes32 account, bytes publicKey"),
  };
  const args = {
    account:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    publicKey: "0x1234",
  } as const;

  const encoded = encodeMutationCalldata(acceptedMutation(mutation, args));

  expect(
    AbiParameters.decode(calldataStructParams(mutation.params), encoded),
  ).toEqual([args]);
});

test("encodeMutationCalldata with resolution", () => {
  const mutation = {
    tag: 1,
    table: testMutationSchema,
    params: parseAbiParameters("uint256 size"),
    resolution: parseAbiParameters("(uint256 price, uint256 size)[] fills"),
    resolve: () => ({ fills: [] }),
  };
  const args = { size: 10n };
  const resolution = {
    fills: [
      { price: 100n, size: 6n },
      { price: 99n, size: 4n },
    ],
  };

  const encoded = encodeMutationCalldata(
    acceptedMutation(mutation, args, resolution),
  );

  expect(
    AbiParameters.decode(
      [
        ...calldataStructParams(mutation.params),
        ...calldataStructParams(mutation.resolution),
      ],
      encoded,
    ),
  ).toEqual([args, resolution]);
});

test("decodeMutationCalldata round-trips without resolution", () => {
  const mutation = {
    tag: 0,
    table: testMutationSchema,
    params: parseAbiParameters("address from, address to, uint256 amount"),
  };
  const args = {
    from: "0x0000000000000000000000000000000000000001",
    to: "0x0000000000000000000000000000000000000002",
    amount: 100n,
  };

  const encoded = encodeMutationCalldata(acceptedMutation(mutation, args));
  const decoded = decodeMutationCalldata(mutation, encoded);

  expect(decoded.args).toEqual(args);
  expect(decoded.resolution).toBeUndefined();
});

test("decodeMutationCalldata round-trips with resolution", () => {
  const mutation = {
    tag: 1,
    table: testMutationSchema,
    params: parseAbiParameters("uint256 size"),
    resolution: parseAbiParameters("(uint256 price, uint256 size)[] fills"),
    resolve: () => ({ fills: [] }),
  };
  const args = { size: 10n };
  const resolution = {
    fills: [
      { price: 100n, size: 6n },
      { price: 99n, size: 4n },
    ],
  };

  const encoded = encodeMutationCalldata(
    acceptedMutation(mutation, args, resolution),
  );
  const decoded = decodeMutationCalldata(mutation, encoded);

  expect(decoded.args).toEqual(args);
  expect(decoded.resolution).toEqual(resolution);
});

test("getSignatureAbiParameters extracts Signature components from execute", () => {
  const params = getSignatureAbiParameters(COUNTER_ABI);
  expect(params).toMatchInlineSnapshot(`
    [
      {
        "internalType": "uint8",
        "name": "keyType",
        "type": "uint8",
      },
      {
        "internalType": "bytes",
        "name": "rawSignature",
        "type": "bytes",
      },
    ]
  `);
});

test("encodeSignatureCalldata encodes a signature record to ABI bytes", () => {
  const sigParams = parseAbiParameters("uint8 keyType, bytes rawSignature");
  const signature = { keyType: 2, rawSignature: "0xdeadbeef" };
  const encoded = encodeSignatureCalldata(sigParams, signature);
  const [decodedKeyType, decodedRawSignature] = AbiParameters.decode(
    sigParams,
    encoded,
  );
  expect(decodedKeyType).toBe(2);
  expect(decodedRawSignature).toBe("0xdeadbeef");
});

test("encodeExecuteCalldata matches viem encodeFunctionData", () => {
  const bundle = {
    mutations: [0],
    mutationData: ["0x1234" as `0x${string}`],
    signatures: [[0, "0xaa"]],
  };
  const expected = encodeFunctionData({
    abi: COUNTER_ABI,
    functionName: "execute",
    args: [[bundle], []] as never,
  });
  const actual = encodeExecuteCalldata(COUNTER_ABI, [bundle], []);
  expect(actual).toBe(expected);
});

test("encodeEnqueueCalldata matches viem encodeFunctionData", () => {
  const sig = { keyType: 0, rawSignature: "0xbb" as `0x${string}` };
  const expected = encodeFunctionData({
    abi: COUNTER_ABI,
    functionName: "enqueue",
    args: [0, "0x1234", sig] as never,
  });
  const actual = encodeEnqueueCalldata(COUNTER_ABI, 0, "0x1234", sig);
  expect(actual).toBe(expected);
});

test.skip("decodeForceInclusionLog decodes event args", () => {
  const eventAbi = COUNTER_ABI.find(
    (item) => item.type === "event" && item.name === "ForceInclusionQueued",
  );
  if (eventAbi === undefined || eventAbi.type !== "event") {
    throw new Error("ForceInclusionQueued event not found in COUNTER_ABI");
  }

  const eventParams = [
    { name: "index", type: "uint256" },
    { name: "mutation", type: "uint8" },
    { name: "mutationData", type: "bytes" },
    {
      name: "sig",
      type: "tuple",
      components: [
        { name: "keyType", type: "uint8" },
        { name: "rawSignature", type: "bytes" },
      ],
    },
    { name: "enqueuedBlock", type: "uint256" },
  ];

  const data = AbiParameters.encode(eventParams, [
    42n,
    1,
    "0xabcd",
    { keyType: 2, rawSignature: "0xdeadbeef" },
    100n,
  ]);

  const topic = toEventSelector(eventAbi as never);
  const log = {
    data,
    topics: [topic] as `0x${string}`[],
  };

  const decoded = decodeForceInclusionLog(
    COUNTER_ABI,
    COUNTER_MUTATIONS.add,
    log,
  );
  expect(decoded.index).toBe(42n);
  expect(decoded.args).toEqual({});
  expect(decoded.signature).toEqual({ keyType: 2, rawSignature: "0xdeadbeef" });
});

test("encodeBundleArg builds a structured bundle value", () => {
  const transfer = {
    tag: 0,
    table: testMutationSchema,
    params: parseAbiParameters("address from, address to, uint256 amount"),
  };
  const market = {
    tag: 1,
    table: testMutationSchema,
    params: parseAbiParameters("uint256 size"),
    resolution: parseAbiParameters("(uint256 price, uint256 size)[] fills"),
    resolve: () => ({ fills: [] }),
  };

  const transferResolved: ResolvedMutation = {
    id: 0,
    status: "accepted",
    name: "transfer",
    args: {
      from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      amount: 100n,
    },
    signature: { keyType: 0, rawSignature: "0xaa" },
    isForceInclusion: false,
    config: transfer,
  };
  const marketResolved: ResolvedMutation = {
    id: 1,
    status: "accepted",
    name: "market",
    args: { size: 10n },
    signature: { keyType: 1, rawSignature: "0xbb" },
    isForceInclusion: false,
    resolution: {
      fills: [
        { price: 100n, size: 6n },
        { price: 99n, size: 4n },
      ],
    },
    config: market,
  };

  const bundle = encodeBundleArg(COUNTER_ABI, [
    transferResolved,
    marketResolved,
  ]);

  expect(bundle.mutations).toEqual([0, 1]);
  expect(bundle.signatures).toEqual([
    [0, "0xaa"],
    [1, "0xbb"],
  ]);

  const [decodedTransfer] = AbiParameters.decode(
    calldataStructParams(transfer.params),
    bundle.mutationData[0]!,
  );
  expect(decodedTransfer).toEqual(transferResolved.args);

  const [decodedMarket, decodedResolution] = AbiParameters.decode(
    [
      ...calldataStructParams(market.params),
      ...calldataStructParams(market.resolution),
    ],
    bundle.mutationData[1]!,
  );
  expect(decodedMarket).toEqual(marketResolved.args);
  expect(decodedResolution).toEqual(marketResolved.resolution);
});
