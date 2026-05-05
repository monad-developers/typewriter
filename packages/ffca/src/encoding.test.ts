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
    signature: "0xaa",
    config: transfer,
  };
  const marketResolved: ResolvedMutation = {
    id: 1,
    status: "accepted",
    name: "market",
    args: { size: 10n },
    signature: "0xbb",
    resolution: {
      fills: [
        { price: 100n, size: 6n },
        { price: 99n, size: 4n },
      ],
    },
    config: market,
  };

  const encoded = encodeBundleCalldata([transferResolved, marketResolved]);

  const [bundle] = AbiParameters.decode(
    AbiParameters.from(
      "(uint8[] mutations, bytes[] mutationData, bytes[] signatures)",
    ),
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
        "0xaa",
        "0xbb",
      ],
    }
  `);
});
