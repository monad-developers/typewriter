import { expect, test } from "bun:test";
import { Hex } from "ox";
import { createClient, custom, type EIP1193RequestFn } from "viem";
import { bytesStorage, layout, OWNER, slotOf } from "../test/utils";
import {
  type AccountStorage,
  readStorageVariable,
  readStorageVariables,
} from "./index";

const ADDRESS = "0x000000000000000000000000000000000000bEEF";

/**
 * A viem client over in-memory storage that records requests.
 */
function mockClient(storage: AccountStorage) {
  const requests: { method: string; params: unknown }[] = [];
  const read = (slot: Hex.Hex) =>
    storage[slot] ?? Hex.fromNumber(0n, { size: 32 });
  const request = (async ({ method, params }) => {
    requests.push({ method, params });
    if (method === "eth_getStorageAt") {
      const [, slot] = params as [Hex.Hex, Hex.Hex, string];
      return read(slot);
    }
    if (method === "eth_getStorageValues") {
      const [byAddress] = params as [Record<Hex.Hex, Hex.Hex[]>, string];
      // Lowercase keys, as a node may return them.
      return Object.fromEntries(
        Object.entries(byAddress).map(([address, slots]) => [
          address.toLowerCase(),
          slots.map(read),
        ]),
      );
    }
    throw new Error(`unexpected method ${method}`);
  }) as EIP1193RequestFn;
  return { client: createClient({ transport: custom({ request }) }), requests };
}

test("readStorageVariables requests each slot once", async () => {
  const { client, requests } = mockClient({
    [slotOf(layout, "owner")]: Hex.padLeft(OWNER, 32),
  });

  // `owner` and `paused` share slot 1.
  const values = await readStorageVariables(client, {
    address: ADDRESS,
    storageLayout: layout,
    variables: ["owner", "paused", "owner", "totalSupply"],
  });

  expect(values).toEqual([OWNER, false, OWNER, 0n]);
  expect(requests).toMatchInlineSnapshot(`
    [
      {
        "method": "eth_getStorageValues",
        "params": [
          {
            "0x000000000000000000000000000000000000bEEF": [
              "0x0000000000000000000000000000000000000000000000000000000000000001",
              "0x0000000000000000000000000000000000000000000000000000000000000000",
            ],
          },
          "latest",
        ],
      },
    ]
  `);
});

test("readStorageVariables with no variables sends no request", async () => {
  const { client, requests } = mockClient({});

  expect(
    await readStorageVariables(client, {
      address: ADDRESS,
      storageLayout: layout,
      variables: [],
    }),
  ).toEqual([]);
  expect(requests).toEqual([]);
});

test("both actions pass block parameters to the request", async () => {
  const { client, requests } = mockClient({});

  await readStorageVariable(client, {
    address: ADDRESS,
    storageLayout: layout,
    variable: "totalSupply",
    blockNumber: 7n,
  });
  await readStorageVariables(client, {
    address: ADDRESS,
    storageLayout: layout,
    variables: ["totalSupply"],
    blockHash: `0x${"ab".repeat(32)}`,
  });

  expect(requests.map(({ params }) => (params as unknown[]).at(-1))).toEqual([
    "0x7",
    { blockHash: `0x${"ab".repeat(32)}` },
  ]);
});

test("a non-concrete variable throws before any request", async () => {
  const { client, requests } = mockClient({});
  const read = readStorageVariables as (
    client: unknown,
    parameters: unknown,
  ) => Promise<unknown>;

  await expect(
    read(client, {
      address: ADDRESS,
      storageLayout: layout,
      variables: ["totalSupply", "balances"],
    }),
  ).rejects.toThrow("mapping storage paths require a key: balances");
  expect(requests).toEqual([]);
});

test("a long bytes value takes a second request for its data slots only", async () => {
  const slot = slotOf(layout, "message");
  const { client, requests } = mockClient(
    bytesStorage(slot, Hex.fromString("a".repeat(70))),
  );

  const [message] = await readStorageVariables(client, {
    address: ADDRESS,
    storageLayout: layout,
    variables: ["message"],
  });

  expect(message).toBe("a".repeat(70));
  // The root slot, then 3 data slots (70 bytes).
  expect(
    requests.map(
      ({ params }) =>
        Object.values((params as [Record<string, unknown[]>])[0])[0]!.length,
    ),
  ).toEqual([1, 3]);
});

test("readStorageVariables throws when the result has no values for the address", async () => {
  const request = (async () => ({})) as EIP1193RequestFn;
  const client = createClient({ transport: custom({ request }) });

  await expect(
    readStorageVariables(client, {
      address: ADDRESS,
      storageLayout: layout,
      variables: ["totalSupply"],
    }),
  ).rejects.toThrow(`getStorageValues returned no values for ${ADDRESS}`);
});
