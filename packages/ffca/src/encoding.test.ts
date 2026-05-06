import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import { AbiParameters } from "ox";
import { encodeBundleCalldata, encodeMutationCalldata } from "./encoding";
import type { ResolvedMutation } from "./types";

test("encodeMutationCalldata without resolution", () => {
  const mutation = {
    tag: 0,
    params: parseAbiParameters("address from, address to, uint256 amount"),
    apply: () => {},
  };
  const args = {
    from: "0x0000000000000000000000000000000000000001",
    to: "0x0000000000000000000000000000000000000002",
    amount: 100n,
  } as const;

  const encoded = encodeMutationCalldata(mutation, args);

  expect(AbiParameters.decode(mutation.params, encoded)).toEqual([
    args.from,
    args.to,
    args.amount,
  ]);
});

test("encodeMutationCalldata with resolution", () => {
  const mutation = {
    tag: 1,
    params: parseAbiParameters("uint256 size"),
    resolution: parseAbiParameters("(uint256 price, uint256 size)[] fills"),
    resolve: () => ({ fills: [] }),
    apply: () => {},
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
    AbiParameters.decode([...mutation.params, ...mutation.resolution], encoded),
  ).toEqual([args.size, resolution.fills]);
});

test("encodeBundleCalldata signatures are typed against signature params", () => {
  const transfer = {
    tag: 0,
    params: parseAbiParameters("address to, uint256 amount"),
    apply: () => {},
  };
  const sigParams = parseAbiParameters(
    "bytes32 account, uint64 keyId, uint8 keyType, bytes rawSignature",
  );

  const m: ResolvedMutation = {
    id: 0,
    status: "accepted",
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
    params: parseAbiParameters("address from, address to, uint256 amount"),
    apply: () => {},
  };
  const market = {
    tag: 1,
    params: parseAbiParameters("uint256 size"),
    resolution: parseAbiParameters("(uint256 price, uint256 size)[] fills"),
    resolve: () => ({ fills: [] }),
    apply: () => {},
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
    config: transfer,
  };
  const marketResolved: ResolvedMutation = {
    id: 1,
    status: "accepted",
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
        "0x000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000630000000000000000000000000000000000000000000000000000000000000004",
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
