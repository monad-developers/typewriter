import { expect, test } from "bun:test";
import { Hash, Hex } from "ox";
import { expectSingleSlot, layout, OWNER, SPENDER } from "../test/utils";
import {
  getStorageSlot,
  recoverStoragePaths,
  type StorageLayout,
} from "./index";

function preimage(preimage: Hex.Hex) {
  return { hash: Hash.keccak256(preimage), preimage };
}

function word(value: bigint): Hex.Hex {
  return Hex.fromNumber(value, { size: 32 });
}

function addressMappingPreimage(key: Hex.Hex, parentSlot: bigint | Hex.Hex) {
  return preimage(
    Hex.concat(
      Hex.padLeft(key, 32),
      typeof parentSlot === "bigint" ? word(parentSlot) : parentSlot,
    ),
  );
}

test("recoverStoragePaths resolves a single-level mapping path", () => {
  const slot = expectSingleSlot(getStorageSlot(layout, `balances[${OWNER}]`));

  expect(
    recoverStoragePaths(layout, [slot], [addressMappingPreimage(OWNER, 7n)]),
  ).toMatchInlineSnapshot(`
    [
      "balances[0x1111111111111111111111111111111111111234]",
    ]
  `);
});

test("recoverStoragePaths resolves nested mapping paths", () => {
  const outer = addressMappingPreimage(OWNER, 13n);
  const inner = addressMappingPreimage(SPENDER, outer.hash);
  const slot = expectSingleSlot(
    getStorageSlot(layout, `allowances[${OWNER}][${SPENDER}]`),
  );

  expect(
    recoverStoragePaths(layout, [slot], [outer, inner]),
  ).toMatchInlineSnapshot(`
    [
      "allowances[0x1111111111111111111111111111111111111234][0x2222222222222222222222222222222222221234]",
    ]
  `);
});

test("recoverStoragePaths resolves dynamic array data paths", () => {
  const slot = expectSingleSlot(getStorageSlot(layout, "dynamicNumbers[1]"));

  expect(
    recoverStoragePaths(layout, [slot], [preimage(word(10n))]),
  ).toMatchInlineSnapshot(`
    [
      "dynamicNumbers[1]",
    ]
  `);
});

test("recoverStoragePaths resolves struct-valued mapping fields", () => {
  const structMappingLayout = {
    storage: [
      {
        astId: 1,
        contract: "src/Test.sol:Test",
        label: "positions",
        offset: 0,
        slot: "0",
        type: "t_mapping(t_address,t_struct(Position)1_storage)",
      },
    ],
    types: {
      t_address: {
        encoding: "inplace",
        label: "address",
        numberOfBytes: "20",
      },
      t_uint256: {
        encoding: "inplace",
        label: "uint256",
        numberOfBytes: "32",
      },
      "t_struct(Position)1_storage": {
        encoding: "inplace",
        label: "struct Test.Position",
        members: [
          {
            astId: 2,
            contract: "src/Test.sol:Test",
            label: "quantity",
            offset: 0,
            slot: "0",
            type: "t_uint256",
          },
          {
            astId: 3,
            contract: "src/Test.sol:Test",
            label: "price",
            offset: 0,
            slot: "1",
            type: "t_uint256",
          },
        ],
        numberOfBytes: "64",
      },
      "t_mapping(t_address,t_struct(Position)1_storage)": {
        encoding: "mapping",
        key: "t_address",
        label: "mapping(address => struct Test.Position)",
        numberOfBytes: "32",
        value: "t_struct(Position)1_storage",
      },
    },
  } as const satisfies StorageLayout;
  const entry = addressMappingPreimage(OWNER, 0n);
  const slot = Hex.fromNumber(BigInt(entry.hash) + 1n, { size: 32 });

  expect(
    recoverStoragePaths(structMappingLayout, [slot], [entry]),
  ).toMatchInlineSnapshot(`
    [
      "positions[0x1111111111111111111111111111111111111234].price",
    ]
  `);
});

test("recoverStoragePaths resolves dynamic bytes data slots to the bytes field", () => {
  const dataBase = Hash.keccak256(word(11n));
  const dataSlot = Hex.fromNumber(BigInt(dataBase) + 2n, { size: 32 });

  expect(
    recoverStoragePaths(layout, [dataSlot], [preimage(word(11n))]),
  ).toMatchInlineSnapshot(`
    [
      "rawBytes",
    ]
  `);
});

test("recoverStoragePaths surfaces a recovery gap for a captured hashed slot", () => {
  // `balances[OWNER]` is a single-slot uint256, so an offset past its hashed
  // value slot has no field to map to. Because the slot still derives from a
  // captured preimage, recovery reports it as a gap rather than dropping it.
  const entry = addressMappingPreimage(OWNER, 7n);
  const gapSlot = Hex.fromNumber(BigInt(entry.hash) + 1n, { size: 32 });

  expect(() => recoverStoragePaths(layout, [gapSlot], [entry])).toThrow(
    "could not recover storage path",
  );
});

test("recoverStoragePaths skips slots no captured preimage produced", () => {
  // A dynamic (string) mapping key hashes a variable-length preimage the
  // harness never records (only 32/64-byte preimages are captured), so the
  // touched slot derives from no captured preimage and is skipped instead of
  // aborting recovery of the other slots.
  const dynamicKeyPreimage = Hex.concat(Hex.fromString("foo"), word(7n));
  const slot = Hash.keccak256(dynamicKeyPreimage);

  expect(
    recoverStoragePaths(
      layout,
      [slot],
      [{ hash: slot, preimage: dynamicKeyPreimage }],
    ),
  ).toEqual([]);
});

test("recoverStoragePaths validates preimage hashes", () => {
  const slot = expectSingleSlot(getStorageSlot(layout, `balances[${OWNER}]`));

  expect(() =>
    recoverStoragePaths(
      layout,
      [slot],
      [
        {
          hash: word(1n),
          preimage: Hex.concat(Hex.padLeft(OWNER, 32), word(7n)),
        },
      ],
    ),
  ).toThrow("keccak preimage hash mismatch");
});
