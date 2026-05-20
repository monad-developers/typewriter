import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import { AbiParameters } from "ox";
import { testMutationSchema } from "../test/utils";
import { encodeBundleCalldata, encodeMutationCalldata } from "./encoding";
import type { ResolvedMutation } from "./types";

function calldataStructParams(
  params: readonly AbiParameters.Parameter[],
): readonly AbiParameters.Parameter[] {
  return [{ type: "tuple", components: params as AbiParameters.Parameter[] }];
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

  const encoded = encodeMutationCalldata(mutation, args);

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

  const encoded = encodeMutationCalldata(mutation, args);

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

  const encoded = encodeMutationCalldata(mutation, args, resolution);

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

test("encodeBundleCalldata signatures are typed against signature params", () => {
  const transfer = {
    tag: 0,
    table: testMutationSchema,
    params: parseAbiParameters("address to, uint256 amount"),
  };
  const sigParams = parseAbiParameters(
    "bytes32 account, uint64 keyId, uint8 keyType, bytes rawSignature",
  );

  const m: ResolvedMutation = {
    id: 0,
    status: "accepted",
    digest:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    name: "transfer",
    args: {
      to: "0x0000000000000000000000000000000000000002",
      amount: 100n,
    },
    signature: {
      account:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      keyId: 7n,
      keyType: 2,
      rawSignature: "0xdeadbeef",
    },
    config: transfer,
  };

  const encoded = encodeBundleCalldata([m], sigParams);
  const [bundle] = AbiParameters.decode(
    AbiParameters.from([
      {
        type: "tuple",
        components: [
          { name: "mutations", type: "uint8[]" },
          { name: "mutationData", type: "bytes[]" },
          {
            name: "signatures",
            type: "tuple[]",
            components: sigParams as unknown as readonly {
              name: string;
              type: string;
            }[],
          },
        ],
      },
    ]),
    encoded,
  );

  expect(bundle.signatures).toMatchInlineSnapshot(`
    [
      {
        "account": "0x1111111111111111111111111111111111111111111111111111111111111111",
        "keyId": 7n,
        "keyType": 2,
        "rawSignature": "0xdeadbeef",
      },
    ]
  `);
});

test("encodeBundleCalldata round-trips through ABI decode", () => {
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
    digest:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    name: "transfer",
    args: {
      from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      amount: 100n,
    },
    signature: { keyType: 0, rawSignature: "0xaa" },
    config: transfer,
  };
  const marketResolved: ResolvedMutation = {
    id: 1,
    status: "accepted",
    digest:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    name: "market",
    args: { size: 10n },
    signature: { keyType: 1, rawSignature: "0xbb" },
    resolution: {
      fills: [
        { price: 100n, size: 6n },
        { price: 99n, size: 4n },
      ],
    },
    config: market,
  };

  const sigParams = parseAbiParameters("uint8 keyType, bytes rawSignature");
  const encoded = encodeBundleCalldata(
    [transferResolved, marketResolved],
    sigParams,
  );

  const [bundle] = AbiParameters.decode(
    AbiParameters.from([
      {
        type: "tuple",
        components: [
          { name: "mutations", type: "uint8[]" },
          { name: "mutationData", type: "bytes[]" },
          {
            name: "signatures",
            type: "tuple[]",
            components: sigParams as unknown as readonly {
              name: string;
              type: string;
            }[],
          },
        ],
      },
    ]),
    encoded,
  );

  expect(bundle).toMatchInlineSnapshot(`
    {
      "mutationData": [
        "0x000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000064",
        "0x000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000630000000000000000000000000000000000000000000000000000000000000004",
      ],
      "mutations": [
        0,
        1,
      ],
      "signatures": [
        {
          "keyType": 0,
          "rawSignature": "0xaa",
        },
        {
          "keyType": 1,
          "rawSignature": "0xbb",
        },
      ],
    }
  `);
});
