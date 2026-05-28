import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import { AbiParameters } from "ox";
import { encodeFunctionData } from "viem";
import { COUNTER_ABI, HARNESS_ABI } from "../test/utils";
import {
  decodeMutationCalldata,
  encodeBatchArg,
  encodeEnqueueCalldata,
  encodeExecuteCalldata,
  encodeMutationCalldata,
  encodeSignatureCalldata,
  getSignatureAbiParameters,
} from "./encoding";
import type { MutationWithResolution } from "./types";

function calldataStructParams(
  params: readonly AbiParameters.Parameter[],
): readonly AbiParameters.Parameter[] {
  return [{ type: "tuple", components: params as AbiParameters.Parameter[] }];
}

function acceptedMutation(
  config: MutationWithResolution["config"],
  args: unknown,
  resolution?: unknown,
): MutationWithResolution {
  return {
    id: 0,
    status: "accepted",
    name: "test",
    args,
    signature: { keyType: 0, rawSignature: "0x" },
    journalId: 0,
    isForceInclusion: false,
    config,
    resolution,
  };
}

test("encodeMutationCalldata without resolution", () => {
  const mutation = {
    tag: 0,
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

test("getSignatureAbiParameters extracts bytes signatures from execute", () => {
  const params = getSignatureAbiParameters(COUNTER_ABI);
  expect(params).toMatchInlineSnapshot(`
    [
      {
        "internalType": "bytes",
        "name": "signature",
        "type": "bytes",
      },
    ]
  `);
});

test("getSignatureAbiParameters extracts tuple Signature components from execute", () => {
  const params = getSignatureAbiParameters(HARNESS_ABI);
  expect(params).toMatchInlineSnapshot(`
    [
      {
        "internalType": "bytes32",
        "name": "account",
        "type": "bytes32",
      },
      {
        "internalType": "uint64",
        "name": "keyId",
        "type": "uint64",
      },
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
  const batch = {
    mutations: [0],
    mutationData: ["0x1234" as `0x${string}`],
    signatures: ["0xaa" as `0x${string}`],
  };
  const expected = encodeFunctionData({
    abi: COUNTER_ABI,
    functionName: "execute",
    args: [[batch], []],
  });
  const actual = encodeExecuteCalldata(COUNTER_ABI, [batch], []);
  expect(actual).toBe(expected);
});

test("encodeEnqueueCalldata matches viem encodeFunctionData", () => {
  const signature = "0xbb" as `0x${string}`;
  const config = {
    tag: 0,
    params: parseAbiParameters("bytes data"),
  };
  const mutation = acceptedMutation(config, { data: "0x1234" });
  mutation.signature = signature;
  const mutationData = encodeMutationCalldata(mutation);
  const expected = encodeFunctionData({
    abi: COUNTER_ABI,
    functionName: "enqueue",
    args: [0, mutationData, signature],
  });
  const actual = encodeEnqueueCalldata(COUNTER_ABI, mutation);
  expect(actual).toBe(expected);
});

test("encodeBatchArg builds a structured batch value", () => {
  const transfer = {
    tag: 0,
    params: parseAbiParameters("address from, address to, uint256 amount"),
  };
  const market = {
    tag: 1,
    params: parseAbiParameters("uint256 size"),
    resolution: parseAbiParameters("(uint256 price, uint256 size)[] fills"),
    resolve: () => ({ fills: [] }),
  };

  const transferResolved: MutationWithResolution = {
    id: 0,
    status: "accepted",
    name: "transfer",
    args: {
      from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      amount: 100n,
    },
    signature: "0xaa",
    journalId: 0,
    isForceInclusion: false,
    config: transfer,
  };
  const marketResolved: MutationWithResolution = {
    id: 1,
    status: "accepted",
    name: "market",
    args: { size: 10n },
    signature: "0xbb",
    journalId: 1,
    isForceInclusion: false,
    resolution: {
      fills: [
        { price: 100n, size: 6n },
        { price: 99n, size: 4n },
      ],
    },
    config: market,
  };

  const batch = encodeBatchArg(COUNTER_ABI, [transferResolved, marketResolved]);

  expect(batch.mutations).toEqual([0, 1]);
  expect(batch.signatures).toEqual(["0xaa", "0xbb"]);

  const [decodedTransfer] = AbiParameters.decode(
    calldataStructParams(transfer.params),
    batch.mutationData[0]!,
  );
  expect(decodedTransfer).toEqual(transferResolved.args);

  const [decodedMarket, decodedResolution] = AbiParameters.decode(
    [
      ...calldataStructParams(market.params),
      ...calldataStructParams(market.resolution),
    ],
    batch.mutationData[1]!,
  );
  expect(decodedMarket).toEqual(marketResolved.args);
  expect(decodedResolution).toEqual(marketResolved.resolution);
});
