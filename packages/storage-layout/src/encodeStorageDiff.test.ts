import { expect, test } from "bun:test";
import { layout, OWNER, SPENDER } from "../test/utils";
import { encodeStorageDiff, type StorageLayout } from "./index";

test("encodeStorageDiff encodes sparse path diffs into sparse slot write diffs", () => {
  expect(
    encodeStorageDiff(layout, {
      pre: { totalSupply: 1n },
      post: { totalSupply: 2n },
    }),
  ).toMatchInlineSnapshot(`
    {
      "post": {
        "0x0000000000000000000000000000000000000000000000000000000000000000": {
          "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "value": "0x0000000000000000000000000000000000000000000000000000000000000002",
        },
      },
      "pre": {
        "0x0000000000000000000000000000000000000000000000000000000000000000": {
          "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "value": "0x0000000000000000000000000000000000000000000000000000000000000001",
        },
      },
    }
  `);
});

test("encodeStorageDiff encodes packed fields into merged slot writes", () => {
  const diff = encodeStorageDiff(layout, {
    pre: { owner: OWNER, paused: true },
    post: { owner: SPENDER, paused: false },
  });

  const ownerSlot =
    "0x0000000000000000000000000000000000000000000000000000000000000001";
  expect(diff.pre[ownerSlot]).toMatchInlineSnapshot(`
    {
      "mask": "0x0000000000000000000000ffffffffffffffffffffffffffffffffffffffffff",
      "value": "0x0000000000000000000000011111111111111111111111111111111111111234",
    }
  `);
  expect(diff.post[ownerSlot]).toMatchInlineSnapshot(`
    {
      "mask": "0x0000000000000000000000ffffffffffffffffffffffffffffffffffffffffff",
      "value": "0x0000000000000000000000002222222222222222222222222222222222221234",
    }
  `);
});

test("encodeStorageDiff rejects conflicting overlapping slot writes", () => {
  const conflictLayout = {
    storage: [
      {
        astId: 1,
        contract: "src/Test.sol:Test",
        label: "a",
        offset: 0,
        slot: "0",
        type: "t_uint256",
      },
      {
        astId: 2,
        contract: "src/Test.sol:Test",
        label: "b",
        offset: 0,
        slot: "0",
        type: "t_uint256",
      },
    ],
    types: {
      t_uint256: {
        encoding: "inplace",
        label: "uint256",
        numberOfBytes: "32",
      },
    },
  } as const satisfies StorageLayout;

  expect(() =>
    encodeStorageDiff(conflictLayout, {
      pre: { a: 1n, b: 2n },
      post: {},
    }),
  ).toThrow("conflicting storage diff writes for overlapping slot masks");
});

test("encodeStorageDiff encodes keyed mappings", () => {
  expect(
    encodeStorageDiff(layout, {
      pre: { [`balances[${OWNER}]`]: 1n },
      post: { [`balances[${OWNER}]`]: 2n },
    }),
  ).toMatchInlineSnapshot(`
    {
      "post": {
        "0x6d30c68d4703e3ad11b778e8635b89709aaecadb8bd3f2e0e0cff25a4ee1fbbc": {
          "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "value": "0x0000000000000000000000000000000000000000000000000000000000000002",
        },
      },
      "pre": {
        "0x6d30c68d4703e3ad11b778e8635b89709aaecadb8bd3f2e0e0cff25a4ee1fbbc": {
          "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "value": "0x0000000000000000000000000000000000000000000000000000000000000001",
        },
      },
    }
  `);
});

test("encodeStorageDiff encodes long bytes diffs", () => {
  const before = `0x${"11".repeat(33)}` as const;
  const after = `0x${"22".repeat(33)}` as const;

  expect(
    encodeStorageDiff(layout, {
      pre: { rawBytes: before },
      post: { rawBytes: after },
    }),
  ).toMatchInlineSnapshot(`
    {
      "post": {
        "0x000000000000000000000000000000000000000000000000000000000000000b": {
          "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "value": "0x0000000000000000000000000000000000000000000000000000000000000043",
        },
        "0x0175b7a638427703f0dbe7bb9bbf987a2551717b34e79f33b5b1008d1fa01db9": {
          "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "value": "0x2222222222222222222222222222222222222222222222222222222222222222",
        },
        "0x0175b7a638427703f0dbe7bb9bbf987a2551717b34e79f33b5b1008d1fa01dba": {
          "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "value": "0x2200000000000000000000000000000000000000000000000000000000000000",
        },
      },
      "pre": {
        "0x000000000000000000000000000000000000000000000000000000000000000b": {
          "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "value": "0x0000000000000000000000000000000000000000000000000000000000000043",
        },
        "0x0175b7a638427703f0dbe7bb9bbf987a2551717b34e79f33b5b1008d1fa01db9": {
          "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "value": "0x1111111111111111111111111111111111111111111111111111111111111111",
        },
        "0x0175b7a638427703f0dbe7bb9bbf987a2551717b34e79f33b5b1008d1fa01dba": {
          "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "value": "0x1100000000000000000000000000000000000000000000000000000000000000",
        },
      },
    }
  `);
});
