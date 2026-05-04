import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import type { TypedData } from "ox";
import { hashTypedData } from "viem";
import type { FFCAMutationConfig } from "./config";
import { hashMutation } from "./eip712";

const domain: TypedData.Domain = {
  name: "ffca-test",
  version: "1",
  chainId: 1,
  verifyingContract: "0x0000000000000000000000000000000000000001",
};

test("hashMutation matches viem hashTypedData for a flat mutation", () => {
  const mutation: FFCAMutationConfig = {
    params: parseAbiParameters("address from, address to, uint256 amount"),
    apply: () => {},
  };
  const args = {
    from: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    to: "0x0000000000000000000000000000000000000002" as `0x${string}`,
    amount: 100n,
  };

  const got = hashMutation(mutation, "Transfer", args, domain);
  const want = hashTypedData({
    domain,
    types: {
      Transfer: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    primaryType: "Transfer",
    message: args,
  });

  expect(got).toBe(want);
});

test("hashMutation handles a tuple param via synthesized struct name", () => {
  const mutation: FFCAMutationConfig = {
    params: parseAbiParameters("(uint256 price, uint256 size) fill"),
    apply: () => {},
  };
  const args = { fill: { price: 100n, size: 6n } };

  const got = hashMutation(mutation, "Settle", args, domain);
  const want = hashTypedData({
    domain,
    types: {
      Settle: [{ name: "fill", type: "Settle_fill" }],
      Settle_fill: [
        { name: "price", type: "uint256" },
        { name: "size", type: "uint256" },
      ],
    },
    primaryType: "Settle",
    message: args,
  });

  expect(got).toBe(want);
});

test("hashMutation handles tuple[] arrays", () => {
  const mutation: FFCAMutationConfig = {
    params: parseAbiParameters(
      "address taker, (uint256 price, uint256 size)[] fills",
    ),
    apply: () => {},
  };
  const args = {
    taker: "0x0000000000000000000000000000000000000003" as `0x${string}`,
    fills: [
      { price: 100n, size: 6n },
      { price: 99n, size: 4n },
    ],
  };

  const got = hashMutation(mutation, "Batch", args, domain);
  const want = hashTypedData({
    domain,
    types: {
      Batch: [
        { name: "taker", type: "address" },
        { name: "fills", type: "Batch_fills[]" },
      ],
      Batch_fills: [
        { name: "price", type: "uint256" },
        { name: "size", type: "uint256" },
      ],
    },
    primaryType: "Batch",
    message: args,
  });

  expect(got).toBe(want);
});

test("hashMutation handles nested tuples", () => {
  const mutation: FFCAMutationConfig = {
    params: parseAbiParameters(
      "(address account, (uint256 price, uint256 size) fill) order",
    ),
    apply: () => {},
  };
  const args = {
    order: {
      account: "0x0000000000000000000000000000000000000004" as `0x${string}`,
      fill: { price: 100n, size: 6n },
    },
  };

  const got = hashMutation(mutation, "PlaceOrder", args, domain);
  const want = hashTypedData({
    domain,
    types: {
      PlaceOrder: [{ name: "order", type: "PlaceOrder_order" }],
      PlaceOrder_order: [
        { name: "account", type: "address" },
        { name: "fill", type: "PlaceOrder_order_fill" },
      ],
      PlaceOrder_order_fill: [
        { name: "price", type: "uint256" },
        { name: "size", type: "uint256" },
      ],
    },
    primaryType: "PlaceOrder",
    message: args,
  });

  expect(got).toBe(want);
});

test("hashMutation uses internalType struct name when present", () => {
  const mutation: FFCAMutationConfig = {
    params: [
      {
        name: "fill",
        type: "tuple",
        internalType: "struct Fill",
        components: [
          { name: "price", type: "uint256", internalType: "uint256" },
          { name: "size", type: "uint256", internalType: "uint256" },
        ],
      },
    ],
    apply: () => {},
  };
  const args = { fill: { price: 100n, size: 6n } };

  const got = hashMutation(mutation, "Settle", args, domain);
  const want = hashTypedData({
    domain,
    types: {
      Settle: [{ name: "fill", type: "Fill" }],
      Fill: [
        { name: "price", type: "uint256" },
        { name: "size", type: "uint256" },
      ],
    },
    primaryType: "Settle",
    message: args,
  });

  expect(got).toBe(want);
});

test("hashMutation rejects unnamed params", () => {
  const mutation: FFCAMutationConfig = {
    params: parseAbiParameters("uint256"),
    apply: () => {},
  };

  expect(() => hashMutation(mutation, "X", [1n], domain)).toThrow(
    /every param must have a name/,
  );
});
