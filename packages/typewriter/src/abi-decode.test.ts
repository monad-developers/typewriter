import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Effect } from "effect";
import { AbiError, AbiParameters, Bytes, Hash, Hex } from "ox";
import { createEVM, type EVM } from "typewriter-evm";
import { abiType, decodeAbiParameters } from "./abi-decode";

type Param = AbiParameters.Parameter;

const word = (value: bigint) => Hex.fromNumber(value, { size: 32 });
const tuple = (...components: Param[]): Param =>
  ({ type: "tuple", components }) as Param;

// `ox` has no strict decoding: `AbiParameters.decode` takes only `as` and
// `checksumAddress`. Each case is bytes `abi.decode` rejects or decodes to
// other values than `ox` returns.
describe("ox decodes differently from abi.decode", () => {
  test("a uint8 with dirty high bits: ox returns 256, abi.decode reverts", () => {
    const data = word(0x100n);
    expect(AbiParameters.decode([{ type: "uint8" }], data)).toEqual([256]);
    expect(() => decodeAbiParameters([{ type: "uint8" }], data)).toThrow(
      "dirty uint8",
    );
  });

  test("an int8 not sign-extended: ox returns 128, abi.decode reverts", () => {
    const data = word(0x80n);
    expect(AbiParameters.decode([{ type: "int8" }], data)).toEqual([128]);
    expect(() => decodeAbiParameters([{ type: "int8" }], data)).toThrow(
      "dirty int8",
    );
  });

  test("an address with dirty high bits: ox drops them, abi.decode reverts", () => {
    const data = Hex.concat(Hex.padLeft("0xff", 12), Hex.padLeft("0x11", 20));
    expect(
      AbiParameters.decode([{ type: "address" }], data, {
        checksumAddress: false,
      }),
    ).toEqual(["0x0000000000000000000000000000000000000011"]);
    expect(() => decodeAbiParameters([{ type: "address" }], data)).toThrow(
      "dirty address",
    );
  });

  test("a bytes2 with dirty low bits: ox drops them, abi.decode reverts", () => {
    const data = Hex.padRight("0xabcd01", 32);
    expect(AbiParameters.decode([{ type: "bytes2" }], data)).toEqual([
      "0xabcd",
    ]);
    expect(() => decodeAbiParameters([{ type: "bytes2" }], data)).toThrow(
      "dirty bytes2",
    );
  });

  test("a string of invalid UTF-8: ox returns U+FFFD, losing the bytes", () => {
    const data = AbiParameters.encode([{ type: "bytes" }], ["0xff"]);
    expect(AbiParameters.decode([{ type: "string" }], data)).toEqual(["�"]);
    // `abi.decode` accepts it, but no JS string holds the byte.
    expect(() => decodeAbiParameters([{ type: "string" }], data)).toThrow();
  });

  test("a string with a leading BOM: ox strips it", () => {
    const data = AbiParameters.encode([{ type: "string" }], ["﻿a"]);
    expect(AbiParameters.decode([{ type: "string" }], data)).toEqual(["a"]);
    expect(decodeAbiParameters([{ type: "string" }], data)).toEqual(["﻿a"]);
  });

  test("offsets that share a tail: ox stops after 8,192 reads, abi.decode accepts", () => {
    // 9,000 `bytes`, every offset pointing at one empty tail.
    const count = 9_000n;
    const tail = 32n * (count + 1n);
    const data = Hex.concat(
      word(0x20n),
      word(count),
      ...Array.from({ length: Number(count) }, () => word(tail - 32n)),
      word(0n),
    );
    expect(() => AbiParameters.decode([{ type: "bytes[]" }], data)).toThrow(
      "Recursive read limit",
    );
    const [decoded] = decodeAbiParameters([{ type: "bytes[]" }], data);
    expect((decoded as Hex.Hex[]).length).toBe(Number(count));
  });
});

// Every ABI type the decoder handles, each decoded as the only field of a
// struct, as mutation params are; then structs of mixed fields.
const INNER = tuple(
  { name: "x", type: "bool" },
  { name: "y", type: "bytes" },
  { name: "z", type: "int24" },
);
const STATIC = tuple(
  { name: "a", type: "uint8" },
  { name: "b", type: "address" },
  { name: "c", type: "bytes4" },
);
const TYPES: Param[] = [
  ...[8, 16, 24, 40, 48, 56, 64, 128, 256].map((bits) => ({
    type: `uint${bits}`,
  })),
  ...[8, 16, 24, 48, 56, 64, 128, 256].map((bits) => ({ type: `int${bits}` })),
  { type: "address" },
  { type: "bool" },
  ...[1, 2, 4, 16, 31, 32].map((size) => ({ type: `bytes${size}` })),
  { type: "bytes" },
  { type: "string" },
  { type: "uint8[3]" },
  { type: "int16[]" },
  { type: "address[2]" },
  { type: "bool[]" },
  { type: "bytes[]" },
  { type: "string[2]" },
  { type: "bytes32[]" },
  { type: "uint256[2][]" },
  { type: "uint8[][2]" },
  { type: "string[][]" },
  INNER,
  { ...INNER, type: "tuple[]" },
  { ...INNER, type: "tuple[2]" },
  STATIC,
  { ...STATIC, type: "tuple[2]" },
  { ...STATIC, type: "tuple[]" },
];
const CASES: Param[] = [
  ...TYPES.map((param) => tuple({ ...param, name: "value" })),
  tuple(
    { name: "a", type: "uint8" },
    { name: "b", type: "bytes" },
    { name: "c", type: "address" },
    { name: "d", type: "string[]" },
    { ...INNER, name: "e" },
    { ...INNER, name: "f", type: "tuple[]" },
    { name: "g", type: "uint16[2]" },
  ),
  tuple(
    { name: "accountID", type: "bytes32" },
    { name: "credentialID", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "expiration", type: "uint40" },
    { name: "signature", type: "bytes" },
  ),
];

/** A Solidity contract with `d<i>(bytes)`, which reverts with `Decoded(abi.encode(abi.decode(data, (S))))` for case `i`. */
function decoderSource(): string {
  const structs: string[] = [];
  const solidityType = (param: Param): string => {
    const type = abiType(param);
    if (type.kind === "array") {
      return `${solidityType(type.item)}[${type.length ?? ""}]`;
    }
    if (type.kind === "value") return type.type;
    const fields = type.components
      .map((component) => `${solidityType(component)} ${component.name};`)
      .join(" ");
    structs.push(`struct S${structs.length} { ${fields} }`);
    return `S${structs.length - 1}`;
  };
  const functions = CASES.map(
    (param, i) =>
      `function d${i}(bytes memory data) external pure { revert Decoded(abi.encode(abi.decode(data, (${solidityType(param)})))); }`,
  );
  return [
    "// SPDX-License-Identifier: MIT",
    "pragma solidity ^0.8.21;",
    "contract Decoder {",
    "error Decoded(bytes);",
    ...structs,
    ...functions,
    "}",
  ].join("\n");
}

const DECODER = "0x00000000000000000000000000000000000dec0d";
const CALLER = "0x0000000000000000000000000000000000001234";
const DECODED = AbiError.from("error Decoded(bytes)");

let evm: EVM;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "typewriter-abi-decode-"));
  await $`mkdir -p ${root}/src`.quiet();
  await writeFile(join(root, "src/Decoder.sol"), decoderSource());
  await writeFile(
    join(root, "foundry.toml"),
    '[profile.default]\nsrc = "src"\nout = "out"\n',
  );
  await $`forge build --root ${root}`.quiet();
  const artifact = await Bun.file(
    join(root, "out/Decoder.sol/Decoder.json"),
  ).json();
  evm = Effect.runSync(
    createEVM({
      spec: "MonadNine",
      chain_id: 1,
      accounts: {
        [DECODER]: { code: artifact.deployedBytecode.object },
        [CALLER]: { balance: "0xffffffffffffffffffff" },
      },
    }),
  );
}, 300_000);

/** `abi.decode`'s re-encoding of `data` as case `i`, or undefined if it reverts. */
function solidityDecode(i: number, data: Hex.Hex): Hex.Hex | undefined {
  const selector = Hex.slice(
    Hash.keccak256(Hex.fromString(`d${i}(bytes)`)),
    0,
    4,
  );
  const result = Effect.runSync(
    evm.simulate({
      from: CALLER,
      to: DECODER,
      data: Hex.concat(
        selector,
        AbiParameters.encode([{ type: "bytes" }], [data]),
      ),
      journal_ids: [],
    }),
  );
  if (result.status !== "revert") {
    throw new Error(`d${i} ended with ${result.status}`);
  }
  if (
    Hex.size(result.data) < 4 ||
    Hex.slice(result.data, 0, 4) !== AbiError.getSelector(DECODED)
  ) {
    return undefined;
  }
  return AbiError.decode(DECODED, result.data) as Hex.Hex;
}

/** A small seeded PRNG, so each run sees the same cases. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const below = (n: number) => Math.floor(next() * n);
  const bytes = (size: number) =>
    Bytes.from(Array.from({ length: size }, () => below(256)));
  const pick = <value>(values: readonly value[]) =>
    values[below(values.length)]!;
  return { next, below, bytes, pick };
}
type Random = ReturnType<typeof random>;

const STRINGS = ["", "a", "héllo", "日本", "\u0000", "﻿bom", "🙂".repeat(9)];

/** A random value of `param`, in the shapes `ox` encodes. */
function randomValue(param: Param, r: Random): unknown {
  const type = abiType(param);
  if (type.kind === "array") {
    return Array.from({ length: type.length ?? r.below(4) }, () =>
      randomValue(type.item, r),
    );
  }
  if (type.kind === "tuple") {
    return Object.fromEntries(
      type.components.map((c) => [c.name, randomValue(c, r)]),
    );
  }
  const integer = /^(u?)int(\d*)$/.exec(type.type);
  if (integer !== null) {
    const bits = Number(integer[2] || 256);
    const raw = Bytes.toBigInt(r.bytes(32));
    const edges = [
      0n,
      1n,
      -1n,
      (1n << BigInt(bits - 1)) - 1n,
      -(1n << BigInt(bits - 1)),
    ];
    let value =
      r.below(3) === 0
        ? r.pick(edges)
        : integer[1] === "u"
          ? BigInt.asUintN(bits, raw)
          : BigInt.asIntN(bits, raw);
    if (integer[1] === "u") value = BigInt.asUintN(bits, value);
    return bits > 48 ? value : Number(value);
  }
  if (type.type === "address") return Hex.fromBytes(r.bytes(20));
  if (type.type === "bool") return r.below(2) === 1;
  if (type.type === "string") return r.pick(STRINGS);
  if (type.type === "bytes")
    return Hex.fromBytes(r.bytes(r.pick([0, 1, 31, 32, 33, 70])));
  return Hex.fromBytes(r.bytes(Number(type.type.slice(5))));
}

const INTERESTING = [
  0n,
  1n,
  0x20n,
  0x40n,
  0x100n,
  (1n << 64n) - 1n,
  1n << 64n,
  1n << 255n,
  (1n << 256n) - 1n,
];

/** `data` with one of the ways an attacker could change an encoding. */
function mutate(data: Bytes.Bytes, r: Random): Bytes.Bytes {
  const words = Math.floor(data.length / 32);
  const out = Bytes.from(data);
  switch (r.below(8)) {
    case 0:
      return out;
    case 1: {
      // Overwrite a word with an edge value, or one near its old value.
      if (words === 0) return out;
      const at = 32 * r.below(words);
      const old = Bytes.toBigInt(out.subarray(at, at + 32));
      const value = BigInt.asUintN(
        256,
        r.below(2) === 0 ? r.pick(INTERESTING) : old + BigInt(r.below(97) - 48),
      );
      out.set(Bytes.fromNumber(value, { size: 32 }), at);
      return out;
    }
    case 2: {
      // Dirty one byte of a word: high bits of a value or low bits of bytesN.
      if (out.length === 0) return out;
      const at = r.below(out.length);
      out[at] = out[at]! ^ (1 << r.below(8));
      return out;
    }
    case 3:
      return out.subarray(0, r.below(out.length + 1));
    case 4:
      return Bytes.concat(out, r.bytes(r.pick([1, 31, 32, 64])));
    case 5: {
      // Insert a word, shifting every tail after it.
      const at = 32 * r.below(words + 1);
      return Bytes.concat(
        out.subarray(0, at),
        Bytes.fromNumber(r.pick(INTERESTING), { size: 32 }),
        out.subarray(at),
      );
    }
    case 6: {
      // Two mutations.
      return mutate(mutate(out, r), r);
    }
    default:
      return r.bytes(r.below(200));
  }
}

/** Runs per case. Set `ABI_DECODE_RUNS` higher to search longer. */
// biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
const RUNS = Number(process.env["ABI_DECODE_RUNS"] ?? 400);

describe("decodeAbiParameters matches abi.decode", () => {
  test.each(CASES.map((param, i) => [i, param] as const))(
    "case %i",
    (i, param) => {
      const r = random(0x5eed + i);
      for (let run = 0; run < RUNS; run++) {
        const encoded = AbiParameters.encode([param], [
          randomValue(param, r),
        ] as never);
        const data = Hex.fromBytes(mutate(Bytes.fromHex(encoded), r));
        const solidity = solidityDecode(i, data);
        let decoded: unknown[] | undefined;
        let error: unknown;
        try {
          decoded = decodeAbiParameters([param], data);
        } catch (e) {
          error = e;
        }
        const context = `case ${i} run ${run}: ${data}`;
        if (decoded === undefined) {
          // The one allowed difference: a string that isn't valid UTF-8.
          if (solidity !== undefined) {
            expect(String(error), context).toContain(
              "encoded data was not valid",
            );
          }
          continue;
        }
        expect(
          solidity,
          `${context} decoded, but abi.decode reverts`,
        ).toBeDefined();
        expect(AbiParameters.encode([param], decoded as never), context).toBe(
          solidity!,
        );
      }
    },
    60_000,
  );
});
