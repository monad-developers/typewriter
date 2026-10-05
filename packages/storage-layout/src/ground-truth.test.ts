// Differential tests against real ground truth: the solc `storageLayout` of
// `test/contracts/src/StorageFixture.sol`, and the storage of that contract on
// anvil after `populate()`. Each decoded value must equal what the getter that
// Solidity generates returns for the same variable.
//
// The other test files use hand-written layouts. This file is the check that
// those layouts, and the decoding rules, agree with the compiler and the EVM.

import { beforeAll, describe, expect, expectTypeOf, test } from "bun:test";
import { Hash, Hex } from "ox";
import type { Address, ContractFunctionName } from "viem";
import { anvil } from "../test/anvil";
import { StorageFixture } from "../test/contracts/generated";
import {
  type AccountStorage,
  createStorageView,
  decodeStorageVariable,
  enumerateMappingKeys,
  getDynamicArrayLength,
  type KeccakPreimage,
} from "./index";
import { resolveStoragePath } from "./storage-layout";
import { parseStoragePath } from "./storage-path";

const ALICE = "0x1111111111111111111111111111111111111234";
const BOB = "0x2222222222222222222222222222222222221234";

const { abi, bytecode, storageLayout: layout } = StorageFixture;
const client = anvil.getClient();

let address: Address;
let preimages: KeccakPreimage[];

beforeAll(async () => {
  address = await deployFixture();
  const hash = await client.writeContract({
    address,
    abi,
    functionName: "populate",
  });
  await client.waitForTransactionReceipt({ hash });
  preimages = await traceKeccakPreimages(hash);
});

// -----------------------------------------------------------------------------
// Helpers

async function deployFixture(): Promise<Address> {
  const hash = await client.deployContract({ abi, bytecode });
  const { contractAddress } = await client.waitForTransactionReceipt({ hash });
  if (contractAddress === null || contractAddress === undefined) {
    throw new Error("StorageFixture deployment has no contract address");
  }
  return contractAddress;
}

type FunctionName = ContractFunctionName<typeof abi, "view" | "pure">;

/** Call a getter of the populated fixture. */
function read(functionName: FunctionName, args: readonly unknown[] = []) {
  return client.readContract({
    address,
    abi,
    functionName,
    args,
  } as never) as Promise<unknown>;
}

/** A `createStorageView` getter that reads slots with `eth_getStorageAt`. */
function getStorageAt(target: () => Address) {
  return (slots: readonly Hex.Hex[]) =>
    Promise.all(
      slots.map(
        async (slot) =>
          (await client.getStorageAt({ address: target(), slot })) ?? "0x0",
      ),
    );
}

/** Account storage for `slots`, in the form that `eth_getProof` returns. */
async function proofStorage(
  slots: readonly Hex.Hex[],
): Promise<AccountStorage> {
  const proof = await client.getProof({ address, storageKeys: [...slots] });
  return Object.fromEntries(
    proof.storageProof.map(({ key, value }) => [key, Hex.fromNumber(value)]),
  );
}

function slotOf(variable: string): Hex.Hex {
  const { slot } = resolveStoragePath(layout, parseStoragePath(variable));
  return Hex.fromNumber(slot, { size: 32 });
}

type StructLog = { op: string; stack?: string[]; memory?: string[] | string };

/**
 * keccak256 preimages of a transaction, from the memory and stack of each
 * `KECCAK256` step in anvil's struct-log trace. This is the input that
 * `enumerateMappingKeys` expects from an execution trace.
 */
async function traceKeccakPreimages(hash: Hex.Hex): Promise<KeccakPreimage[]> {
  const trace = (await client.request({
    method: "debug_traceTransaction",
    params: [hash, { enableMemory: true }],
  } as never)) as { structLogs: StructLog[] };

  const result: KeccakPreimage[] = [];
  for (const { op, stack, memory } of trace.structLogs) {
    if (op !== "KECCAK256" && op !== "SHA3") continue;
    if (stack === undefined || memory === undefined) {
      throw new Error("debug_traceTransaction returned no stack or memory");
    }
    const offset = Number(stack.at(-1));
    const size = Number(stack.at(-2));
    // Memory is a list of 32-byte words, each with or without a `0x` prefix.
    const bytes = (Array.isArray(memory) ? memory : [memory])
      .map((word) => word.replace(/^0x/, ""))
      .join("");
    const preimage: Hex.Hex = `0x${bytes.slice(offset * 2, (offset + size) * 2)}`;
    result.push({ hash: Hash.keccak256(preimage), preimage });
  }
  return result;
}

// -----------------------------------------------------------------------------
// Fixture

test("the fixture constants agree with the contract", async () => {
  expect(await read("ALICE")).toBe(ALICE);
  expect(await read("BOB")).toBe(BOB);
  expect(preimages.length).toBeGreaterThan(0);
});

// -----------------------------------------------------------------------------
// createStorageView over eth_getStorageAt

describe("createStorageView matches the Solidity getters", () => {
  const state = createStorageView(
    layout,
    getStorageAt(() => address),
  );

  test("value types, including packed slots and the number/bigint boundary", async () => {
    const names = [
      "totalSupply",
      "owner",
      "paused",
      "debt",
      "decimals",
      "signedBig",
      "salt",
      "selector",
      "u48",
      "u56",
      "i8",
      "i48",
      "status",
    ] as const;
    for (const name of names) {
      expect({ name, value: await state[name] }).toEqual({
        name,
        value: (await read(name)) as never,
      });
    }
  });

  test("structs, including a nested struct and a struct with a mapping", async () => {
    const [lastUpdate, active, admin, inner] = (await read("metadata")) as [
      bigint,
      boolean,
      Address,
      { count: bigint },
    ];
    expect(await state.metadata.lastUpdate).toBe(lastUpdate);
    expect(await state.metadata.active).toBe(active);
    expect(await state.metadata.admin).toBe(admin);
    expect(await state.metadata.inner.count).toBe(inner.count);

    expect(await state.book.id).toBe((await read("bookId")) as bigint);
    expect(await state.book.name).toBe((await read("bookName")) as string);
    expect(await state.book.deposits[ALICE]).toBe(
      (await read("bookDeposits", [ALICE])) as bigint,
    );
    expect(await state.book.levels.length).toBe(
      Number(await read("bookLevelsLength")),
    );
    for (let index = 0; index < 5; index++) {
      expect(await state.book.levels[index]).toBe(
        (await read("bookLevels", [BigInt(index)])) as bigint,
      );
    }
  });

  test("fixed arrays, including nested and struct elements", async () => {
    expect(state.fixedNumbers.length).toBe(3);
    for (let index = 0; index < 3; index++) {
      expect(await state.fixedNumbers[index]).toBe(
        (await read("fixedNumbers", [BigInt(index)])) as bigint,
      );
      for (let column = 0; column < 2; column++) {
        expect(await state.matrix[index]![column]).toBe(
          (await read("matrix", [BigInt(index), BigInt(column)])) as bigint,
        );
      }
    }
    for (let index = 0; index < 2; index++) {
      expect(await state.inners[index]!.count).toBe(
        (await read("inners", [BigInt(index)])) as bigint,
      );
    }
  });

  test("dynamic arrays, including packed bools across slots and structs", async () => {
    expect(await state.dynamicNumbers.length).toBe(
      Number(await read("dynamicNumbersLength")),
    );
    for (let index = 0; index < 3; index++) {
      expect(await state.dynamicNumbers[index]).toBe(
        (await read("dynamicNumbers", [BigInt(index)])) as bigint,
      );
    }

    // 40 bools pack 32 per slot, so the elements cross a slot boundary.
    const flagsLength = await state.flags.length;
    expect(flagsLength).toBe(Number(await read("flagsLength")));
    for (let index = 0; index < flagsLength; index++) {
      expect(await state.flags[index]).toBe(
        (await read("flags", [BigInt(index)])) as boolean,
      );
    }

    for (let index = 0; index < 3; index++) {
      expect(await state.addresses[index]).toBe(
        (await read("addresses", [BigInt(index)])) as Address,
      );
    }

    expect(await state.orders.length).toBe(Number(await read("ordersLength")));
    for (let index = 0; index < 2; index++) {
      const order = state.orders[index]!;
      expect([
        await order.price,
        await order.amount,
        await order.status,
        await order.id,
      ]).toEqual((await read("orders", [BigInt(index)])) as never);
    }
  });

  test("bytes and strings in the short, 32-byte, and long forms", async () => {
    const names = [
      "emptyBytes",
      "shortBytes",
      "exactBytes",
      "longBytes",
      "shortString",
      "longString",
    ] as const;
    for (const name of names) {
      expect({ name, value: await state[name] }).toEqual({
        name,
        value: (await read(name)) as string,
      });
    }
  });

  test("mappings with each supported key type", async () => {
    expect(await state.balances[ALICE]).toBe(
      (await read("balances", [ALICE])) as bigint,
    );
    expect(await state.allowances[ALICE]![BOB]).toBe(
      (await read("allowances", [ALICE, BOB])) as bigint,
    );
    expect(await state.allowances[BOB]![ALICE]).toBe(
      (await read("allowances", [BOB, ALICE])) as bigint,
    );

    const order = state.ordersById["7"]!;
    expect([
      await order.price,
      await order.amount,
      await order.status,
      await order.id,
    ]).toEqual((await read("ordersById", [7n])) as never);

    const minInt64 = -(2n ** 63n);
    expect(await state.signedKeys["-1"]).toBe(
      (await read("signedKeys", [-1n])) as boolean,
    );
    expect(await state.signedKeys[`${minInt64}` as `${number}`]).toBe(
      (await read("signedKeys", [minInt64])) as boolean,
    );

    const selector = (await read("selector")) as Hex.Hex;
    expect(await state.bySelector[selector]).toBe(
      (await read("bySelector", [selector])) as Address,
    );
    expect(await state.byBool.true).toBe(
      (await read("byBool", [true])) as number,
    );
    expect(await state.byBool.false).toBe(
      (await read("byBool", [false])) as number,
    );

    expect(await state.history[ALICE]!.length).toBe(
      Number(await read("historyLength", [ALICE])),
    );
    expect(await state.history[ALICE]![1]).toBe(
      (await read("history", [ALICE, 1n])) as bigint,
    );
    expect(await state.names[ALICE]).toBe(
      (await read("names", [ALICE])) as string,
    );
    expect(await state.names[BOB]).toBe((await read("names", [BOB])) as string);
    expect(await state.nested["1"]!["-5"]).toBe(
      (await read("nested", [1, -5n])) as Hex.Hex,
    );
  });

  test("a key that was never written reads as zero, like the getter", async () => {
    const stranger = "0x3333333333333333333333333333333333333333";
    expect(await state.balances[stranger]).toBe(0n);
    expect(await read("balances", [stranger])).toBe(0n);
  });

  test("contract and user-defined value types fail loudly", async () => {
    await expect(state.self as unknown as Promise<unknown>).rejects.toThrow(
      "unsupported storage path type 'contract StorageFixture' for self",
    );
    await expect(state.price as unknown as Promise<unknown>).rejects.toThrow(
      "unsupported storage path type 'StorageFixture.Price' for price",
    );
  });

  test("leaf types come from the solc layout", () => {
    expectTypeOf(state.totalSupply).toEqualTypeOf<Promise<bigint>>();
    expectTypeOf(state.u48).toEqualTypeOf<Promise<number>>();
    expectTypeOf(state.u56).toEqualTypeOf<Promise<bigint>>();
    expectTypeOf(state.status).toEqualTypeOf<Promise<number>>();
    expectTypeOf(state.metadata.admin).toEqualTypeOf<Promise<Hex.Hex>>();
    expectTypeOf(state.longString).toEqualTypeOf<Promise<string>>();
    expectTypeOf(state.dynamicNumbers.length).toEqualTypeOf<Promise<number>>();
  });
});

// -----------------------------------------------------------------------------
// Decoders over eth_getProof

describe("decoders over eth_getProof storage", () => {
  test("decodeStorageVariable decodes a value from proof storage", async () => {
    const variable = `allowances[${BOB}][${ALICE}]` as const;
    const storage = await proofStorage([slotOf(variable)]);

    expect(decodeStorageVariable(layout, variable, storage)).toBe(
      (await read("allowances", [BOB, ALICE])) as bigint,
    );
  });

  test("decodeStorageVariable reads a long string from its data slots", async () => {
    const root = await proofStorage([slotOf("longString")]);
    const rootWord = BigInt(Object.values(root)[0]!);
    const length = Number(rootWord >> 1n);
    const dataSlot = BigInt(Hash.keccak256(slotOf("longString")));
    const dataSlots = Array.from({ length: Math.ceil(length / 32) }, (_, i) =>
      Hex.fromNumber(dataSlot + BigInt(i), { size: 32 }),
    );
    const storage = { ...root, ...(await proofStorage(dataSlots)) };

    expect(decodeStorageVariable(layout, "longString", storage)).toBe(
      (await read("longString")) as string,
    );
  });

  test("getDynamicArrayLength reads an array inside a mapping", async () => {
    const variable = `history[${ALICE}]` as const;
    const storage = await proofStorage([slotOf(variable)]);

    expect(getDynamicArrayLength(layout, variable, storage)).toBe(
      Number(await read("historyLength", [ALICE])),
    );
  });
});

// -----------------------------------------------------------------------------
// Mapping keys from an execution trace

describe("enumerateMappingKeys over traced preimages", () => {
  test("lists the keys that populate() wrote, for each key type", () => {
    expect(enumerateMappingKeys(layout, "balances", preimages)).toEqual([
      `balances[${ALICE}]`,
      `balances[${BOB}]`,
    ]);
    expect(enumerateMappingKeys(layout, "allowances", preimages)).toEqual([
      `allowances[${ALICE}]`,
      `allowances[${BOB}]`,
    ]);
    expect(
      enumerateMappingKeys(layout, `allowances[${ALICE}]`, preimages),
    ).toEqual([`allowances[${ALICE}][${BOB}]`]);
    expect(enumerateMappingKeys(layout, "ordersById", preimages)).toEqual([
      "ordersById[7]",
    ]);
    expect(enumerateMappingKeys(layout, "signedKeys", preimages)).toEqual([
      "signedKeys[-1]",
      "signedKeys[-9223372036854775808]",
    ]);
    expect(enumerateMappingKeys(layout, "byBool", preimages)).toEqual([
      "byBool[true]",
      "byBool[false]",
    ]);
    expect(enumerateMappingKeys(layout, "nested", preimages)).toEqual([
      "nested[1]",
    ]);
    expect(enumerateMappingKeys(layout, "nested[1]", preimages)).toEqual([
      "nested[1][-5]",
    ]);
    expect(enumerateMappingKeys(layout, "book.deposits", preimages)).toEqual([
      `book.deposits[${ALICE}]`,
      `book.deposits[${BOB}]`,
    ]);
    expect(enumerateMappingKeys(layout, "history", preimages)).toEqual([
      `history[${ALICE}]`,
      `history[${BOB}]`,
    ]);
    expect(enumerateMappingKeys(layout, "names", preimages)).toEqual([
      `names[${ALICE}]`,
      `names[${BOB}]`,
    ]);
  });

  test("a view enumerates the same keys from the same preimages", () => {
    const state = createStorageView(
      layout,
      getStorageAt(() => address),
      preimages,
    );

    expect(Object.keys(state.balances)).toEqual([ALICE, BOB]);
    expect(Object.keys(state.signedKeys)).toEqual(["-1", `${-(2n ** 63n)}`]);
  });
});

// -----------------------------------------------------------------------------
// Encodings that Solidity rejects

test("a bytes root word that Solidity rejects with panic 0x22 also throws here", async () => {
  const target = await deployFixture();
  // Long form (lowest bit 1) with a length of 5: not a valid encoding.
  await client.setStorageAt({
    address: target,
    index: slotOf("shortString"),
    value: Hex.fromNumber(5n * 2n + 1n, { size: 32 }),
  });

  await expect(
    client.readContract({ address: target, abi, functionName: "shortString" }),
  ).rejects.toThrow("0x22");
  await expect(
    createStorageView(
      layout,
      getStorageAt(() => target),
    ).shortString,
  ).rejects.toThrow("incorrectly encoded bytes length slot: shortString");
});
