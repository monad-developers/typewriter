import { expect, test } from "bun:test";
import { AbiParameters, Hash, Hex, Signature } from "ox";
import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  decodeAuthorizationCalldata,
  decodeMutationCalldata,
  encodeAuthorizationCalldata,
  encodeBatchArg,
  encodeEnqueueCalldata,
  encodeExecuteCalldata,
  encodeMutationCalldata,
  encodeSchedulerCredentials,
  encodeSecp256k1PublicKey,
  encodeSecp256k1Signature,
  secp256k1SchedulerCredential,
} from "./encoding";
import {
  AUTHORIZATION_ABI_PARAMS,
  EXECUTE_EIP712_TYPES,
  KeyType,
  ROOT_PERMISSIONS,
  SCHEDULER_ADD_CREDENTIAL_EIP712_TYPES,
  SCHEDULER_REMOVE_CREDENTIAL_EIP712_TYPES,
  SchedulerRole,
  TYPEWRITER_ABI,
  TYPEWRITER_EIP712_DOMAIN,
} from "./typewriter-constants";
import type { AcceptedMutation, Authorization } from "./typewriter-types";

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
  expiration: 1_900_000_000,
  signature: "0xdeadbeef",
} as const satisfies Authorization;

function acceptedMutation(
  config: AcceptedMutation["config"],
  params: unknown,
  authorization: Authorization = AUTHORIZATION,
): AcceptedMutation {
  return {
    status: "accepted",
    name: "test",
    params,
    authorization,
    executionIndex: 0n,
    config,
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

  const encoded = encodeMutationCalldata(acceptedMutation(mutation, params));

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

  const encoded = encodeMutationCalldata(acceptedMutation(mutation, params));

  expect(
    AbiParameters.decode(calldataStructParams(mutation.params), encoded),
  ).toEqual([params]);
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

const FROM_EXECUTION_HASH = `0x${"03".padStart(64, "0")}` as const;

test("encodeExecuteCalldata matches viem encodeFunctionData", () => {
  const batch = {
    mutations: [0],
    mutationData: ["0x1234" as `0x${string}`],
    authorizationData: ["0xaa" as `0x${string}`],
  };
  const expected = encodeFunctionData({
    abi: TYPEWRITER_ABI,
    functionName: "execute",
    args: [
      FROM_EXECUTION_HASH,
      9,
      batch,
      [4n],
      { credentialID: 3n, signature: "0xabcd" },
    ],
  });
  const actual = encodeExecuteCalldata(FROM_EXECUTION_HASH, 9n, batch, [4n], {
    credentialID: 3n,
    signature: "0xabcd",
  });
  expect(actual).toBe(expected);
  expect(
    encodeExecuteCalldata(FROM_EXECUTION_HASH, 9n, batch, [], {
      credentialID: 0n,
      signature: "0x",
    }),
  ).toBe(
    encodeFunctionData({
      abi: TYPEWRITER_ABI,
      functionName: "execute",
      args: [
        FROM_EXECUTION_HASH,
        9,
        batch,
        [],
        { credentialID: 0n, signature: "0x" },
      ],
    }),
  );
});

test("ROOT_PERMISSIONS matches Typewriter.sol", () => {
  expect(ROOT_PERMISSIONS).toBe((1n << 254n) | (1n << 255n));
});

const DOMAIN = {
  ...TYPEWRITER_EIP712_DOMAIN,
  chainId: 10,
  verifyingContract: "0x1111111111111111111111111111111111111111",
} as const;

/** `DOMAIN_SEPARATOR` of `DOMAIN`, as Typewriter.sol's constructor computes it. */
const DOMAIN_SEPARATOR = keccak256(
  encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "address" },
    ],
    [
      keccak256(
        toHex(
          "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
        ),
      ),
      keccak256(toHex("Typewriter")),
      keccak256(toHex("1")),
      10n,
      DOMAIN.verifyingContract,
    ],
  ),
);

/** `keccak256("\x19\x01" ‖ DOMAIN_SEPARATOR ‖ structHash)`, as `_hashTypedData` computes it. */
const digestOf = (
  typeString: string,
  types: { type: string }[],
  values: unknown[],
) =>
  keccak256(
    Hex.concat(
      "0x1901",
      DOMAIN_SEPARATOR,
      keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, ...types],
          [Hash.keccak256(Hex.fromString(typeString)), ...values],
        ),
      ),
    ),
  );

// The type strings are the ones Typewriter.t.sol pins its typehashes to.
test("an execute authorization hashes as the `Execute` type Typewriter.sol pins", () => {
  const message = {
    fromExecutionHash: keccak256(toHex("from")),
    toExecutionHash: keccak256(toHex("to")),
    timestamp: 123456,
    relayer: "0x000000000000000000000000000000000000ABcD",
  } as const;

  expect(
    hashTypedData({
      domain: DOMAIN,
      types: EXECUTE_EIP712_TYPES,
      primaryType: "Execute",
      message,
    }),
  ).toBe(
    digestOf(
      "Execute(bytes32 fromExecutionHash,bytes32 toExecutionHash,uint40 timestamp,address relayer)",
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint40" },
        { type: "address" },
      ],
      [
        message.fromExecutionHash,
        message.toExecutionHash,
        message.timestamp,
        message.relayer,
      ],
    ),
  );
});

test("scheduler credential changes hash as the types Typewriter.sol pins", () => {
  const credential = {
    expiration: 99,
    keyType: KeyType.P256,
    role: SchedulerRole.Issuer,
    publicKey: "0x0102",
  } as const;

  expect(
    hashTypedData({
      domain: DOMAIN,
      types: SCHEDULER_ADD_CREDENTIAL_EIP712_TYPES,
      primaryType: "SchedulerAddCredential",
      message: { ...credential, nonce: 5n, deadline: 77 },
    }),
  ).toBe(
    digestOf(
      "SchedulerAddCredential(uint40 expiration,uint8 keyType,uint8 role,bytes publicKey,uint256 nonce,uint40 deadline)",
      [
        { type: "uint40" },
        { type: "uint8" },
        { type: "uint8" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint40" },
      ],
      [99, KeyType.P256, SchedulerRole.Issuer, keccak256("0x0102"), 5n, 77],
    ),
  );
  expect(
    hashTypedData({
      domain: DOMAIN,
      types: SCHEDULER_REMOVE_CREDENTIAL_EIP712_TYPES,
      primaryType: "SchedulerRemoveCredential",
      message: { credentialID: 4n, nonce: 5n, deadline: 77 },
    }),
  ).toBe(
    digestOf(
      "SchedulerRemoveCredential(uint64 credentialID,uint256 nonce,uint40 deadline)",
      [{ type: "uint64" }, { type: "uint256" }, { type: "uint40" }],
      [4n, 5n, 77],
    ),
  );
});

test("encodeSecp256k1Signature produces the 65-byte signature viem and cast return", async () => {
  const account = privateKeyToAccount(`0x${"42".repeat(32)}`);
  const typedData = {
    domain: { ...TYPEWRITER_EIP712_DOMAIN, chainId: 1 },
    types: EXECUTE_EIP712_TYPES,
    primaryType: "Execute",
    message: {
      fromExecutionHash: `0x${"01".repeat(32)}`,
      toExecutionHash: `0x${"02".repeat(32)}`,
      timestamp: 1,
      relayer: account.address,
    },
  } as const;
  const signature = await account.signTypedData(typedData);

  const { r, s, yParity } = Signature.fromHex(signature);
  expect(encodeSecp256k1Signature(BigInt(r), BigInt(s), yParity)).toBe(
    signature,
  );
  expect(await recoverTypedDataAddress({ ...typedData, signature })).toBe(
    account.address,
  );
});

test("encodeSchedulerCredentials encodes the app constructor's SchedulerCredential[]", () => {
  const address = "0x2222222222222222222222222222222222222222";
  const credential = secp256k1SchedulerCredential(
    address,
    SchedulerRole.Executor,
    7,
  );
  expect(credential).toEqual({
    expiration: 7,
    keyType: KeyType.Secp256k1,
    role: SchedulerRole.Executor,
    publicKey: encodeAbiParameters([{ type: "address" }], [address]),
  });
  expect(encodeSecp256k1PublicKey(address)).toBe(credential.publicKey);
  expect(encodeSchedulerCredentials([credential])).toBe(
    encodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "expiration", type: "uint40" },
            { name: "keyType", type: "uint8" },
            { name: "role", type: "uint8" },
            { name: "publicKey", type: "bytes" },
          ],
        },
      ],
      [[credential]],
    ),
  );
});

test("encodeEnqueueCalldata matches viem encodeFunctionData", () => {
  const config = {
    id: 3,
    params: [{ name: "data", type: "bytes" }],
  };
  const mutation = acceptedMutation(config, { data: "0x1234" });
  const mutationData = encodeMutationCalldata(mutation);
  const authorizationData = encodeAuthorizationCalldata(AUTHORIZATION);
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
