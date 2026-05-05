import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import type { TypedData } from "ox";
import type { FFCAConfig } from "./config";
import { createFFCA, verifyMutation } from "./runtime";

const domain: TypedData.Domain = {
  name: "ffca-test",
  version: "1",
  chainId: 1,
  verifyingContract: "0x0000000000000000000000000000000000000001",
};

const transferConfig = {
  address: "0x0000000000000000000000000000000000000000",
  abi: [],
  // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
  account: {} as any,
  chainId: 1,
  rpcUrl: "http://localhost:8545",
  domain: { name: "ffca-test", version: "1" },
  state: { initial: {} },
  mutations: {
    transfer: {
      params: parseAbiParameters("address from, address to, uint256 amount"),
      apply: () => {},
    },
  },
} satisfies FFCAConfig;

test("verifyMutation accepts a well-formed mutation", () => {
  expect(() =>
    verifyMutation(
      transferConfig,
      "transfer",
      {
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        amount: 5n,
      },
      domain,
    ),
  ).not.toThrow();
});

test("verifyMutation throws on unknown mutation name", () => {
  expect(() => verifyMutation(transferConfig, "nope", {}, domain)).toThrow(
    /unknown mutation: nope/,
  );
});

test("verifyMutation throws when args is not an object", () => {
  expect(() =>
    verifyMutation(transferConfig, "transfer", null, domain),
  ).toThrow(/args must be an object/);
  expect(() =>
    verifyMutation(transferConfig, "transfer", "string", domain),
  ).toThrow(/args must be an object/);
});

test("verifyMutation throws on missing required field", () => {
  expect(() =>
    verifyMutation(
      transferConfig,
      "transfer",
      {
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        // missing amount
      },
      domain,
    ),
  ).toThrow(/missing field: amount/);
});

test("verifyMutation throws on invalid address", () => {
  expect(() =>
    verifyMutation(
      transferConfig,
      "transfer",
      {
        from: "not-an-address",
        to: "0x0000000000000000000000000000000000000002",
        amount: 5n,
      },
      domain,
    ),
  ).toThrow(/Address.*invalid/);
});

test("verifyMutation throws on uint overflow", () => {
  expect(() =>
    verifyMutation(
      transferConfig,
      "transfer",
      {
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        amount: 2n ** 256n,
      },
      domain,
    ),
  ).toThrow(/safe 256-bit unsigned integer range/);
});

test("ffca.domain is derived from config", async () => {
  const ffca = createFFCA({
    ...transferConfig,
    address: "0x000000000000000000000000000000000000abcd",
    chainId: 137,
    domain: { name: "my-app", version: "2" },
  });

  expect(ffca.domain).toEqual({
    name: "my-app",
    version: "2",
    chainId: 137,
    verifyingContract: "0x000000000000000000000000000000000000abcd",
  });

  await ffca.stop();
});
