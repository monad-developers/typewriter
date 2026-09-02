import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import { AbiParameters } from "ox";
import { encodeFunctionData } from "viem";
import {
  AUTHORIZATION_ABI_PARAMS,
  decodeAuthorizationCalldata,
  decodeMutationCalldata,
  encodeAuthorizationCalldata,
  encodeBatchArg,
  encodeEnqueueCalldata,
  encodeExecuteCalldata,
  encodeMutationCalldata,
  TYPEWRITER_ABI,
} from "./encoding";
import type { Authorization, ExecutableMutation } from "./types";

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

function acceptedMutation(
  config: ExecutableMutation["config"],
  params: unknown,
  authorization: Authorization = AUTHORIZATION,
): ExecutableMutation {
  return {
    id: 0,
    status: "accepted",
    name: "test",
    params,
    authorization,
    journalId: 0,
    isForceInclusion: false,
    config,
  };
}

test("encodeMutationCalldata wraps params as one struct", () => {
  const mutation = {
    id: 0,
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
    id: 0,
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
    id: 0,
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
    params: parseAbiParameters("bytes data"),
  };
  const mutation = acceptedMutation(config, { data: "0x1234" });
  const mutationData = encodeMutationCalldata(mutation);
  const authorizationData = encodeAuthorizationCalldata(AUTHORIZATION);
  const expected = encodeFunctionData({
    abi: TYPEWRITER_ABI,
    functionName: "enqueue",
    args: [3, mutationData, authorizationData],
  });
  const actual = encodeEnqueueCalldata(mutation);
  expect(actual).toBe(expected);
});

test("encodeBatchArg builds a structured batch value", () => {
  const transfer = {
    id: 0,
    params: parseAbiParameters("address from, address to, uint256 amount"),
  };
  const market = {
    id: 1,
    params: parseAbiParameters("uint256 size"),
  };
  const secondAuthorization = {
    ...AUTHORIZATION,
    accountID:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    credentialID: 8n,
    signature: "0xbeef",
  } as const satisfies Authorization;
  const transferResolved = acceptedMutation(transfer, {
    from: "0x0000000000000000000000000000000000000001",
    to: "0x0000000000000000000000000000000000000002",
    amount: 100n,
  });
  const marketResolved = acceptedMutation(
    market,
    { size: 10n },
    secondAuthorization,
  );

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
