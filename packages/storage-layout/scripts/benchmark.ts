// Mean time per operation. Compare against `main` on the same machine.
//
//   bun run benchmark
//   BENCH_KEYS=50000 bun run benchmark

import { Hash, Hex } from "ox";
import {
  type AccountStorage,
  createStorageView,
  decodeStorageVariable,
  enumerateMappingKeys,
  type KeccakPreimage,
} from "../src/index";
import { bytesStorage, layout, OWNER, SPENDER, slotOf } from "../test/utils";

const KEYS = readPositiveInt("BENCH_KEYS", 10_000);
const MIN_TIME_MS = readPositiveInt("BENCH_MIN_TIME_MS", 250);

const word = (value: bigint | Hex.Hex) =>
  Hex.padLeft(typeof value === "bigint" ? Hex.fromNumber(value) : value, 32);

function mappingPreimage(key: Hex.Hex, slot: bigint | Hex.Hex): KeccakPreimage {
  const preimage = Hex.concat(word(key), word(slot));
  return { hash: Hash.keccak256(preimage), preimage };
}

const accounts = Array.from({ length: KEYS }, (_, index) =>
  Hex.fromNumber(index + 1, { size: 20 }),
);
// `balances` (slot 7) keys, plus as many unrelated `allowances` keys, so
// enumeration has to skip half of the preimages.
const preimages = [
  ...accounts.map((account) => mappingPreimage(account, 7n)),
  ...accounts.map((account) => mappingPreimage(account, 13n)),
];

const storage: AccountStorage = {
  [word(0n)]: "0x2a",
  [slotOf(layout, "metadata.inner.count")]: "0x7",
  [slotOf(layout, `allowances[${OWNER}][${SPENDER}]`)]: "0x64",
  ...bytesStorage(slotOf(layout, "message"), Hex.fromString("x".repeat(100))),
};
const getStorage = (slots: readonly Hex.Hex[]): Hex.Hex[] =>
  slots.map((slot) => storage[slot] ?? "0x0");
const getStorageAsync = async (slots: readonly Hex.Hex[]) => getStorage(slots);

const state = createStorageView(layout, getStorage, preimages);
const asyncState = createStorageView(layout, getStorageAsync, preimages);

const results = [
  await bench("decodeStorageVariable: uint256 (baseline)", () =>
    decodeStorageVariable(layout, "totalSupply", storage),
  ),
  await bench("view: uint256", () => state.totalSupply),
  await bench("view: nested struct field", () => state.metadata.inner.count),
  await bench("view: nested mapping", () => state.allowances[OWNER]![SPENDER]),
  await bench("view: 100-byte string (two reads)", () => state.message),
  await bench("view async: uint256", () => asyncState.totalSupply),
  await bench(`view: Object.keys(mapping), ${preimages.length} preimages`, () =>
    Object.keys(state.balances),
  ),
  await bench(`enumerateMappingKeys, ${preimages.length} preimages`, () =>
    enumerateMappingKeys(layout, "balances", preimages),
  ),
];

console.table(results);

/** Mean time of `fn` over at least `MIN_TIME_MS`, after a warm-up. */
async function bench(name: string, fn: () => unknown) {
  const run = async () => {
    const result = fn();
    if (result instanceof Promise) await result;
  };
  for (let index = 0; index < 10; index++) await run();

  let iterations = 0;
  let elapsed = 0;
  const startedAt = performance.now();
  while (elapsed < MIN_TIME_MS) {
    await run();
    iterations++;
    elapsed = performance.now() - startedAt;
  }
  return {
    case: name,
    iterations,
    "mean (µs)": Number(((elapsed / iterations) * 1000).toFixed(2)),
  };
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) === false || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}
