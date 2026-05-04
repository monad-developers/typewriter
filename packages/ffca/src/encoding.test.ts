import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import { AbiParameters } from "ox";
import { encodeMutation } from "./encoding";

test("encodeMutation without resolution", () => {
  const mutation = {
    params: parseAbiParameters("address from, address to, uint256 amount"),
    apply: () => {},
  };
  const args = [
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
    100n,
  ] as const;

  const encoded = encodeMutation(mutation, args);

  expect(AbiParameters.decode(mutation.params, encoded)).toEqual(args);
});

test("encodeMutation with resolution", () => {
  const mutation = {
    params: parseAbiParameters("uint256 size"),
    resolution: parseAbiParameters("(uint256 price, uint256 size)[] fills"),
    resolve: () => ({ fills: [] }),
    apply: () => {},
  };
  const args = [10n] as const;
  const resolution = [
    [
      { price: 100n, size: 6n },
      { price: 99n, size: 4n },
    ],
  ] as const;

  const encoded = encodeMutation(mutation, args, resolution);

  expect(
    AbiParameters.decode(
      [...mutation.params, ...mutation.resolution],
      encoded,
    ),
  ).toEqual([...args, ...resolution]);
});
