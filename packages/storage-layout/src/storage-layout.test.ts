import { expect, test } from "bun:test";
import { layout, OWNER } from "../test/utils";
import {
  formatStoragePath,
  getStaticStoragePaths,
  getStorageSlot,
  isStoragePathEnd,
  type StorageLayout,
} from "./index";

test("getStorageSlot resolves top-level value types", () => {
  expect(getStorageSlot(layout, "owner")).toMatchInlineSnapshot(`
    [
      {
        "numberOfBytes": 20,
        "offset": 0,
        "path": {
          "root": "owner",
          "segments": [],
        },
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000001",
        "type": "address",
      },
    ]
  `);
  expect(getStorageSlot(layout, "paused")).toMatchInlineSnapshot(`
    [
      {
        "numberOfBytes": 1,
        "offset": 20,
        "path": {
          "root": "paused",
          "segments": [],
        },
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000001",
        "type": "bool",
      },
    ]
  `);
});

test("getStorageSlot resolves struct fields and whole structs", () => {
  expect(getStorageSlot(layout, "metadata.lastUpdate")).toMatchInlineSnapshot(`
    [
      {
        "numberOfBytes": 8,
        "offset": 0,
        "path": {
          "root": "metadata",
          "segments": [
            {
              "kind": "field",
              "name": "lastUpdate",
            },
          ],
        },
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000004",
        "type": "uint64",
      },
    ]
  `);
  expect(
    getStorageSlot(layout, "metadata").map(({ path }) =>
      formatStoragePath(path),
    ),
  ).toMatchInlineSnapshot(`
      [
        "metadata.lastUpdate",
        "metadata.active",
        "metadata.admin",
        "metadata.inner.count",
      ]
    `);
});

test("getStorageSlot rejects whole structs with dynamic fields", () => {
  const dynamicStructLayout = {
    storage: [
      {
        astId: 20,
        contract: "src/Test.sol:Test",
        label: "holder",
        offset: 0,
        slot: "0",
        type: "t_struct(HasDynamic)21_storage",
      },
    ],
    types: {
      ...layout.types,
      "t_struct(HasDynamic)21_storage": {
        encoding: "inplace",
        label: "struct Test.HasDynamic",
        members: [
          {
            astId: 21,
            contract: "src/Test.sol:Test",
            label: "value",
            offset: 0,
            slot: "0",
            type: "t_uint256",
          },
          {
            astId: 22,
            contract: "src/Test.sol:Test",
            label: "balances",
            offset: 0,
            slot: "1",
            type: "t_mapping(t_address,t_uint256)",
          },
        ],
        numberOfBytes: "64",
      },
    },
  } as const satisfies StorageLayout;

  expect(
    getStaticStoragePaths(dynamicStructLayout).map(formatStoragePath),
  ).toMatchInlineSnapshot(`
    [
      "holder.value",
    ]
  `);
  expect(getStorageSlot(dynamicStructLayout, "holder.value")).toHaveLength(1);
  expect(() => getStorageSlot(dynamicStructLayout, "holder")).toThrow(
    "unsupported storage path type 'mapping(address => uint256)' for holder.balances",
  );
});

test("isStoragePathEnd identifies terminal paths", () => {
  expect(isStoragePathEnd(layout, "totalSupply")).toBe(true);
  expect(isStoragePathEnd(layout, "metadata")).toBe(false);
  expect(isStoragePathEnd(layout, "metadata.lastUpdate")).toBe(true);
  expect(isStoragePathEnd(layout, "metadata.inner")).toBe(false);
  expect(isStoragePathEnd(layout, "balances")).toBe(false);
  expect(isStoragePathEnd(layout, `${"balances"}[${OWNER}]`)).toBe(true);
});

test("getStaticStoragePaths omits mappings", () => {
  expect(
    getStaticStoragePaths(layout).map(formatStoragePath),
  ).toMatchInlineSnapshot(`
      [
        "totalSupply",
        "owner",
        "paused",
        "debt",
        "salt",
        "metadata.lastUpdate",
        "metadata.active",
        "metadata.admin",
        "metadata.inner.count",
      ]
    `);
});

test("nested and dynamic paths fail explicitly until implemented", () => {
  expect(() => getStorageSlot(layout, "balances[0x1234]")).toThrow(
    "subscript storage paths are not supported yet: balances[0x1234]",
  );
  expect(() => getStorageSlot(layout, "balances")).toThrow(
    "unsupported storage path type 'mapping(address => uint256)' for balances",
  );
});
