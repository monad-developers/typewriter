// Compares decoded values from the solc layout and anvil storage of
// `StorageFixture.sol` with the Solidity getters.

import { beforeAll, describe, expect, expectTypeOf, test } from "bun:test";
import { Hash, Hex } from "ox";
import {
  type Address,
  type ContractFunctionName,
  createPublicClient,
  custom,
} from "viem";
import { foundry } from "viem/chains";
import { anvil } from "../test/anvil";
import { StorageFixture } from "../test/contracts/generated";
import { slotOf } from "../test/utils";
import {
  type AccountStorage,
  createStorageView,
  decodeStorageVariable,
  enumerateMappingKeys,
  getDynamicArrayLength,
  type KeccakPreimages,
  readStorageVariable,
  readStorageVariables,
} from "./index";

const ALICE = "0x1111111111111111111111111111111111111234";
const BOB = "0x2222222222222222222222222222222222221234";

const { abi, bytecode, storageLayout: layout } = StorageFixture;
const client = anvil.getClient();

let address: Address;
let preimages: KeccakPreimages;

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

async function deployFixture(): Promise<Address> {
  const hash = await client.deployContract({ abi, bytecode });
  const { contractAddress } = await client.waitForTransactionReceipt({ hash });
  if (contractAddress === null || contractAddress === undefined) {
    throw new Error("StorageFixture deployment has no contract address");
  }
  return contractAddress;
}

type FunctionName = ContractFunctionName<typeof abi, "view" | "pure">;

/** Call a getter of the fixture. */
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

type StructLog = { op: string; stack?: string[]; memory?: string[] | string };

/** keccak256 preimages from the `KECCAK256` steps of a transaction trace. */
async function traceKeccakPreimages(hash: Hex.Hex): Promise<KeccakPreimages> {
  const trace = (await client.request({
    method: "debug_traceTransaction",
    params: [hash, { enableMemory: true, disableStorage: true }],
  } as never)) as { structLogs: StructLog[] };

  const result = new Set<Hex.Hex>();
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
    result.add(preimage.toLowerCase() as Hex.Hex);
  }
  return result;
}

test("the fixture constants agree with the contract", async () => {
  expect(await read("ALICE")).toBe(ALICE);
  expect(await read("BOB")).toBe(BOB);
  expect(preimages.size).toBeGreaterThan(0);
});

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

describe("decoders over eth_getProof storage", () => {
  test("decodeStorageVariable decodes a value from proof storage", async () => {
    const variable = `allowances[${BOB}][${ALICE}]` as const;
    const storage = await proofStorage([slotOf(layout, variable)]);

    expect(decodeStorageVariable(layout, variable, storage)).toBe(
      (await read("allowances", [BOB, ALICE])) as bigint,
    );
  });

  test("decodeStorageVariable reads a long string from its data slots", async () => {
    const root = await proofStorage([slotOf(layout, "longString")]);
    const rootWord = BigInt(Object.values(root)[0]!);
    const length = Number(rootWord >> 1n);
    const dataSlot = BigInt(Hash.keccak256(slotOf(layout, "longString")));
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
    const storage = await proofStorage([slotOf(layout, variable)]);

    expect(getDynamicArrayLength(layout, variable, storage)).toBe(
      Number(await read("historyLength", [ALICE])),
    );
  });
});

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

/** A public client that records the RPC method of each request. */
function recordingClient() {
  const methods: string[] = [];
  const recording = createPublicClient({
    chain: foundry,
    transport: custom({
      async request(args) {
        methods.push(args.method);
        return client.request(args as never);
      },
    }),
  });
  return { client: recording, methods };
}

describe("readStorageVariable and readStorageVariables", () => {
  test("readStorageVariable reads one slot with eth_getStorageAt", async () => {
    const { client: recording, methods } = recordingClient();
    const balance = await readStorageVariable(recording, {
      address,
      storageLayout: layout,
      variable: `balances[${BOB}]`,
    });

    expectTypeOf(balance).toEqualTypeOf<bigint>();
    expect(balance).toBe((await read("balances", [BOB])) as bigint);
    expect(methods).toEqual(["eth_getStorageAt"]);
  });

  test("readStorageVariable reads a long string from its data slots", async () => {
    const { client: recording, methods } = recordingClient();
    const value = await readStorageVariable(recording, {
      address,
      storageLayout: layout,
      variable: "longString",
    });

    expect(value).toBe((await read("longString")) as string);
    // The root slot, then 3 data slots (72 bytes).
    expect(methods).toHaveLength(1 + 3);
    expect(new Set(methods)).toEqual(new Set(["eth_getStorageAt"]));
  });

  test("readStorageVariables reads every slot in one eth_getStorageValues request", async () => {
    const { client: recording, methods } = recordingClient();
    const values = await readStorageVariables(recording, {
      address,
      storageLayout: layout,
      // `owner`, `paused`, and `debt` share one packed slot.
      variables: [
        "totalSupply",
        "owner",
        "paused",
        "debt",
        "u48",
        `allowances[${ALICE}][${BOB}]`,
        "shortString",
      ],
    });

    expectTypeOf(values).toEqualTypeOf<
      [bigint, Address, boolean, number, number, bigint, string]
    >();
    expect(values).toEqual([
      (await read("totalSupply")) as bigint,
      (await read("owner")) as Address,
      (await read("paused")) as boolean,
      (await read("debt")) as number,
      (await read("u48")) as number,
      (await read("allowances", [ALICE, BOB])) as bigint,
      (await read("shortString")) as string,
    ]);
    expect(methods).toEqual(["eth_getStorageValues"]);
  });

  test("readStorageVariables takes a second request for long bytes and strings", async () => {
    const { client: recording, methods } = recordingClient();
    const values = await readStorageVariables(recording, {
      address,
      storageLayout: layout,
      variables: ["longBytes", "longString", `names[${BOB}]`, "book.name"],
    });

    expect(values).toEqual([
      (await read("longBytes")) as Hex.Hex,
      (await read("longString")) as string,
      (await read("names", [BOB])) as string,
      (await read("bookName")) as string,
    ]);
    expect(methods).toEqual(["eth_getStorageValues", "eth_getStorageValues"]);
  });

  test("both actions read at a block number", async () => {
    const target = await deployFixture();
    const deployBlock = await client.getBlockNumber();
    const hash = await client.writeContract({
      address: target,
      abi,
      functionName: "populate",
    });
    await client.waitForTransactionReceipt({ hash });

    const parameters = { address: target, storageLayout: layout } as const;
    expect(
      await readStorageVariable(client, {
        ...parameters,
        variable: "longString",
        blockNumber: deployBlock,
      }),
    ).toBe("");
    expect(
      await readStorageVariables(client, {
        ...parameters,
        variables: ["totalSupply", "longString"],
        blockNumber: deployBlock,
      }),
    ).toEqual([0n, ""]);
    expect(
      await readStorageVariables(client, {
        ...parameters,
        variables: ["totalSupply"],
      }),
    ).toEqual([(await read("totalSupply")) as bigint]);
  });

  test("a forge artifact spreads into the parameters, like a viem contract config", async () => {
    const [owner] = await readStorageVariables(client, {
      ...StorageFixture,
      address,
      variables: ["owner"],
    });

    expect(owner).toBe((await read("owner")) as Address);
  });
});

test("a bytes root word that Solidity rejects with panic 0x22 also throws here", async () => {
  const target = await deployFixture();
  // Long form (lowest bit 1) with a length of 5: not a valid encoding.
  await client.setStorageAt({
    address: target,
    index: slotOf(layout, "shortString"),
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
