import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import { AbiParameters } from "ox";
import { encodeFunctionData } from "viem";
import { COUNTER_SIGNATURE_PARAMS } from "../test/utils";
import {
  decodeMutationCalldata,
  decodeSignatureCalldata,
  encodeBatchArg,
  encodeEnqueueCalldata,
  encodeExecuteCalldata,
  encodeMutationCalldata,
  encodeSignatureCalldata,
  FFCA_ABI,
} from "./encoding";
import type { ExecutableMutation } from "./types";

function calldataStructParams(
  params: readonly AbiParameters.Parameter[],
): readonly AbiParameters.Parameter[] {
  return [{ type: "tuple", components: params as AbiParameters.Parameter[] }];
}

function acceptedMutation(
  config: ExecutableMutation["config"],
  params: unknown,
): ExecutableMutation {
  return {
    id: 0,
    status: "accepted",
    name: "test",
    params,
    signature: "0x",
    journalId: 0,
    isForceInclusion: false,
    config,
  };
}

test("encodeMutationCalldata wraps params as one struct", () => {
  const mutation = {
    tag: 0,
    params: parseAbiParameters("address from, address to, uint256 amount"),
  };
  const params = {
    from: "0x0000000000000000000000000000000000000001",
    to: "0x0000000000000000000000000000000000000002",
    amount: 100n,
  } as const;

  const encoded = encodeMutationCalldata(acceptedMutation(mutation, params));

  expect(
    AbiParameters.decode(calldataStructParams(mutation.params), encoded),
  ).toEqual([params]);
});

test("encodeMutationCalldata wraps dynamic params as one struct", () => {
  const mutation = {
    tag: 0,
    params: parseAbiParameters("bytes32 account, bytes publicKey"),
  };
  const params = {
    account:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    publicKey: "0x1234",
  } as const;

  const encoded = encodeMutationCalldata(acceptedMutation(mutation, params));

  expect(
    AbiParameters.decode(calldataStructParams(mutation.params), encoded),
  ).toEqual([params]);
});

test("decodeMutationCalldata round-trips params", () => {
  const mutation = {
    tag: 0,
    params: parseAbiParameters("address from, address to, uint256 amount"),
  };
  const params = {
    from: "0x0000000000000000000000000000000000000001",
    to: "0x0000000000000000000000000000000000000002",
    amount: 100n,
  };

  const encoded = encodeMutationCalldata(acceptedMutation(mutation, params));
  const decoded = decodeMutationCalldata(mutation, encoded);

  expect(decoded.params).toEqual(params);
});

test("encodeSignatureCalldata encodes signatures as one Solidity struct", () => {
  const signature = {
    accountId:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    publicKey: "0x1234",
    rawSignature: "0xdeadbeef",
  } as const;

  const encoded = encodeSignatureCalldata(COUNTER_SIGNATURE_PARAMS, signature);

  expect(encoded).toBe(
    AbiParameters.encode(calldataStructParams(COUNTER_SIGNATURE_PARAMS), [
      signature,
    ]),
  );
  expect(decodeSignatureCalldata(COUNTER_SIGNATURE_PARAMS, encoded)).toEqual(
    signature,
  );
});

test("encodeExecuteCalldata matches viem encodeFunctionData", () => {
  const batch = {
    mutations: [0],
    mutationData: ["0x1234" as `0x${string}`],
    signatureData: ["0xaa" as `0x${string}`],
  };
  const expected = encodeFunctionData({
    abi: FFCA_ABI,
    functionName: "execute",
    args: [[batch], []],
  });
  const actual = encodeExecuteCalldata([batch], []);
  expect(actual).toBe(expected);
});

test("encodeEnqueueCalldata matches viem encodeFunctionData", () => {
  const signature = {
    accountId:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    publicKey: "0x1234",
    rawSignature: "0xbb",
  } as const;
  const config = {
    tag: 0,
    params: parseAbiParameters("bytes data"),
  };
  const mutation = acceptedMutation(config, { data: "0x1234" });
  mutation.signature = signature;
  const mutationData = encodeMutationCalldata(mutation);
  const signatureData = encodeSignatureCalldata(
    COUNTER_SIGNATURE_PARAMS,
    signature,
  );
  const expected = encodeFunctionData({
    abi: FFCA_ABI,
    functionName: "enqueue",
    args: [0, mutationData, signatureData],
  });
  const actual = encodeEnqueueCalldata(COUNTER_SIGNATURE_PARAMS, mutation);
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
  };

  const transferResolved: ExecutableMutation = {
    id: 0,
    status: "accepted",
    name: "transfer",
    params: {
      from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      amount: 100n,
    },
    signature: {
      accountId:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      publicKey: "0x1234",
      rawSignature: "0xaa",
    },
    journalId: 0,
    isForceInclusion: false,
    config: transfer,
  };
  const marketResolved: ExecutableMutation = {
    id: 1,
    status: "accepted",
    name: "market",
    params: { size: 10n },
    signature: {
      accountId:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      publicKey: "0x5678",
      rawSignature: "0xbb",
    },
    journalId: 1,
    isForceInclusion: false,
    config: market,
  };

  const batch = encodeBatchArg(COUNTER_SIGNATURE_PARAMS, [
    transferResolved,
    marketResolved,
  ]);

  expect(batch.mutations).toEqual([0, 1]);
  expect(batch.signatureData).toEqual([
    encodeSignatureCalldata(
      COUNTER_SIGNATURE_PARAMS,
      transferResolved.signature,
    ),
    encodeSignatureCalldata(COUNTER_SIGNATURE_PARAMS, marketResolved.signature),
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
