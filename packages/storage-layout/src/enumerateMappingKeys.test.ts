import { expect, test } from "bun:test";
import { Hash, Hex } from "ox";
import { layout, OWNER, SPENDER, slotOf } from "../test/utils";
import { enumerateMappingKeys, type StorageLayout } from "./index";

function word(value: bigint | Hex.Hex): Hex.Hex {
  return Hex.padLeft(
    typeof value === "bigint" ? Hex.fromNumber(value) : value,
    32,
  );
}

/** The preimage Solidity hashes for `mapping[key]` at `mappingSlot`. */
function entry(key: Hex.Hex, mappingSlot: bigint | Hex.Hex): Hex.Hex {
  return Hex.concat(word(key), word(mappingSlot)).toLowerCase() as Hex.Hex;
}

test("enumerateMappingKeys lists keys hashed with the mapping slot", () => {
  const preimages = new Set([
    entry(OWNER, 7n), // balances (slot 7)
    entry(SPENDER, 7n),
    entry(OWNER, 13n), // allowances, another mapping
    word(7n), // 32 bytes
    entry(`0x01${"00".repeat(11)}${OWNER.slice(2)}`, 7n), // dirty address word
    `0x${entry(`0x${"cd".repeat(20)}`, 7n)
      .slice(2)
      .toUpperCase()}` as Hex.Hex, // not lowercase
  ]);

  expect(enumerateMappingKeys(layout, "balances", preimages)).toEqual([
    `balances[${OWNER}]`,
    `balances[${SPENDER}]`,
  ]);
});

test("enumerateMappingKeys lists inner keys of nested mappings", () => {
  const outer = entry(OWNER, 13n);
  const inner = entry(SPENDER, Hash.keccak256(outer));
  const preimages = new Set([outer, inner]);

  expect(enumerateMappingKeys(layout, "allowances", preimages)).toEqual([
    `allowances[${OWNER}]`,
  ]);
  expect(
    enumerateMappingKeys(layout, `allowances[${OWNER}]`, preimages),
  ).toEqual([`allowances[${OWNER}][${SPENDER}]`]);
  expect(slotOf(layout, `allowances[${OWNER}][${SPENDER}]`)).toBe(
    Hash.keccak256(inner),
  );
});

test("enumerateMappingKeys finds mappings inside structs and arrays", () => {
  const nestedLayout = {
    storage: [
      {
        astId: 1,
        contract: "src/Test.sol:Test",
        label: "books",
        offset: 0,
        slot: "3",
        type: "t_array(t_struct(Book)1_storage)dyn_storage",
      },
    ],
    types: {
      t_address: { encoding: "inplace", label: "address", numberOfBytes: "20" },
      t_int8: { encoding: "inplace", label: "int8", numberOfBytes: "1" },
      t_uint256: { encoding: "inplace", label: "uint256", numberOfBytes: "32" },
      "t_mapping(t_int8,t_uint256)": {
        encoding: "mapping",
        key: "t_int8",
        label: "mapping(int8 => uint256)",
        numberOfBytes: "32",
        value: "t_uint256",
      },
      "t_struct(Book)1_storage": {
        encoding: "inplace",
        label: "struct Test.Book",
        members: [
          {
            astId: 2,
            contract: "src/Test.sol:Test",
            label: "owner",
            offset: 0,
            slot: "0",
            type: "t_address",
          },
          {
            astId: 3,
            contract: "src/Test.sol:Test",
            label: "levels",
            offset: 0,
            slot: "1",
            type: "t_mapping(t_int8,t_uint256)",
          },
        ],
        numberOfBytes: "64",
      },
      "t_array(t_struct(Book)1_storage)dyn_storage": {
        base: "t_struct(Book)1_storage",
        encoding: "dynamic_array",
        label: "struct Test.Book[]",
        numberOfBytes: "32",
      },
    },
  } as const satisfies StorageLayout;
  const levelsSlot = slotOf(nestedLayout, "books[2].levels");

  expect(
    enumerateMappingKeys(
      nestedLayout,
      "books[2].levels",
      new Set([
        entry(Hex.fromNumber(BigInt.asUintN(256, -3n)), levelsSlot),
        entry("0x05", levelsSlot),
        entry("0x05", slotOf(nestedLayout, "books[1].levels")),
      ]),
    ),
  ).toEqual(["books[2].levels[-3]", "books[2].levels[5]"]);
});

test("enumerateMappingKeys rejects selectors that are not mappings", () => {
  const enumerate = enumerateMappingKeys as (
    layout: StorageLayout,
    mapping: string,
    preimages: ReadonlySet<Hex.Hex>,
  ) => string[];

  expect(() => enumerate(layout, "totalSupply", new Set())).toThrow(
    "storage path is not a mapping: totalSupply",
  );
  expect(() => enumerate(layout, `balances[${OWNER}]`, new Set())).toThrow(
    `storage path is not a mapping: balances[${OWNER}]`,
  );
});
