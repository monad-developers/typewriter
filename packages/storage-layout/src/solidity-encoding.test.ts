import { expect, test } from "bun:test";
import { Address, Hex } from "ox";
import {
  decodeMappingKey,
  encodeMappingKey,
  parseValueType,
} from "./solidity-encoding";
import type { StorageType } from "./storage-layout";
import type { StoragePathSubscript } from "./storage-path";

function valueType(label: string, numberOfBytes = "32"): StorageType {
  return {
    encoding: "inplace",
    label,
    numberOfBytes: `${Number(numberOfBytes)}`,
  };
}

test("parseValueType classifies value types", () => {
  expect([
    parseValueType(valueType("uint")),
    parseValueType(valueType("int16", "2")),
    parseValueType(valueType("address", "20")),
    parseValueType(valueType("bool", "1")),
    parseValueType(valueType("bytes4", "4")),
    parseValueType(valueType("enum Test.Side", "1")),
    parseValueType(valueType("fixed128x18", "16")),
    parseValueType({ encoding: "bytes", label: "bytes", numberOfBytes: "32" }),
  ]).toMatchInlineSnapshot(`
    [
      {
        "bits": 256,
        "kind": "uint",
      },
      {
        "bits": 16,
        "kind": "int",
      },
      {
        "kind": "address",
      },
      {
        "kind": "bool",
      },
      {
        "kind": "fixedBytes",
        "size": 4,
      },
      {
        "kind": "enum",
      },
      undefined,
      undefined,
    ]
  `);
  expect(() => parseValueType(valueType("uint7"))).toThrow(
    "invalid Solidity integer type: uint7",
  );
});

test("mapping keys round-trip through encode and decode", () => {
  const cases: [StorageType, StoragePathSubscript][] = [
    [
      valueType("address", "20"),
      { kind: "hex", value: Address.checksum(`0x${"ab".repeat(20)}`) },
    ],
    [valueType("bool", "1"), { kind: "bool", value: true }],
    [valueType("uint8", "1"), { kind: "number", value: 255n }],
    [valueType("int8", "1"), { kind: "number", value: -128n }],
    [valueType("int256"), { kind: "number", value: -1n }],
    [valueType("bytes4", "4"), { kind: "hex", value: "0x12345678" }],
  ];

  for (const [keyType, key] of cases) {
    const word = encodeMappingKey(keyType, key, "map");
    expect(Hex.size(word)).toBe(32);
    expect(decodeMappingKey(keyType, word)).toEqual(key);
  }
});

test("decodeMappingKey rejects non-canonical key words", () => {
  const word = (hex: string) => Hex.padLeft(hex as Hex.Hex, 32);

  expect(
    decodeMappingKey(
      valueType("address", "20"),
      word(`0x01${"00".repeat(20)}`),
    ),
  ).toBeUndefined();
  expect(
    decodeMappingKey(valueType("bool", "1"), word("0x02")),
  ).toBeUndefined();
  expect(
    decodeMappingKey(valueType("uint8", "1"), word("0x0100")),
  ).toBeUndefined();
  // int8 -1 must be sign-extended to 32 bytes; 0xff alone is 255.
  expect(
    decodeMappingKey(valueType("int8", "1"), word("0xff")),
  ).toBeUndefined();
  expect(
    decodeMappingKey(
      valueType("bytes4", "4"),
      `0x12345678${"00".repeat(27)}01`,
    ),
  ).toBeUndefined();
});

test("encodeMappingKey rejects keys that do not fit the key type", () => {
  expect(() =>
    encodeMappingKey(
      valueType("uint8", "1"),
      { kind: "number", value: 256n },
      "map",
    ),
  ).toThrow("mapping key for 'map' must be within the uint8 range 0 to 255");
  expect(() =>
    encodeMappingKey(
      valueType("bytes4", "4"),
      { kind: "hex", value: "0x12" },
      "map",
    ),
  ).toThrow("mapping key for 'map' must be 4 bytes");
  expect(() =>
    encodeMappingKey(
      { encoding: "bytes", label: "string", numberOfBytes: "32" },
      { kind: "string", value: "a" },
      "map",
    ),
  ).toThrow("unsupported mapping key type: string");
});
