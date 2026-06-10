import type { Hex } from "ox";
import { createStorageProxy, type StorageLayout } from "../src";

type HexString = `0x${string}`;
type Side = "bids" | "asks";

type OrderBookLikeState = {
  readonly accounts: Record<
    HexString,
    {
      readonly balances: Record<HexString, unknown>;
      readonly nonces: Record<`${number}`, unknown>;
    }
  >;
  readonly instruments: Record<
    `${number}`,
    {
      readonly bids: Record<`${number}`, unknown>;
      readonly asks: Record<`${number}`, unknown>;
    }
  >;
};

const layout = {
  storage: [
    {
      astId: 1,
      contract: "contracts/Exchange.sol:Exchange",
      label: "accounts",
      offset: 0,
      slot: "0",
      type: "t_mapping_bytes32_account",
    },
    {
      astId: 2,
      contract: "contracts/Exchange.sol:Exchange",
      label: "instruments",
      offset: 0,
      slot: "1",
      type: "t_mapping_uint64_instrument",
    },
  ],
  types: {
    t_address: {
      encoding: "inplace",
      label: "address",
      numberOfBytes: "20",
    },
    t_bytes32: {
      encoding: "inplace",
      label: "bytes32",
      numberOfBytes: "32",
    },
    t_uint8: {
      encoding: "inplace",
      label: "uint8",
      numberOfBytes: "1",
    },
    t_uint32: {
      encoding: "inplace",
      label: "uint32",
      numberOfBytes: "4",
    },
    t_uint64: {
      encoding: "inplace",
      label: "uint64",
      numberOfBytes: "8",
    },
    t_uint192: {
      encoding: "inplace",
      label: "uint192",
      numberOfBytes: "24",
    },
    t_uint256: {
      encoding: "inplace",
      label: "uint256",
      numberOfBytes: "32",
    },
    t_mapping_address_uint256: {
      encoding: "mapping",
      key: "t_address",
      label: "mapping(address => uint256)",
      numberOfBytes: "32",
      value: "t_uint256",
    },
    t_mapping_bytes32_account: {
      encoding: "mapping",
      key: "t_bytes32",
      label: "mapping(bytes32 => struct Account)",
      numberOfBytes: "32",
      value: "t_struct_account",
    },
    t_mapping_uint64_instrument: {
      encoding: "mapping",
      key: "t_uint64",
      label: "mapping(uint64 => struct Instrument)",
      numberOfBytes: "32",
      value: "t_struct_instrument",
    },
    t_mapping_uint64_tick: {
      encoding: "mapping",
      key: "t_uint64",
      label: "mapping(uint64 => struct Tick)",
      numberOfBytes: "32",
      value: "t_struct_tick",
    },
    t_mapping_uint192_uint64: {
      encoding: "mapping",
      key: "t_uint192",
      label: "mapping(uint192 => uint64)",
      numberOfBytes: "32",
      value: "t_uint64",
    },
    t_struct_account: {
      encoding: "inplace",
      label: "struct Account",
      members: [
        {
          astId: 3,
          contract: "contracts/Exchange.sol:Exchange",
          label: "nonces",
          offset: 0,
          slot: "0",
          type: "t_mapping_uint192_uint64",
        },
        {
          astId: 4,
          contract: "contracts/Exchange.sol:Exchange",
          label: "balances",
          offset: 0,
          slot: "1",
          type: "t_mapping_address_uint256",
        },
      ],
      numberOfBytes: "64",
    },
    t_struct_instrument: {
      encoding: "inplace",
      label: "struct Instrument",
      members: [
        {
          astId: 5,
          contract: "contracts/Exchange.sol:Exchange",
          label: "base",
          offset: 0,
          slot: "0",
          type: "t_address",
        },
        {
          astId: 6,
          contract: "contracts/Exchange.sol:Exchange",
          label: "quote",
          offset: 0,
          slot: "1",
          type: "t_address",
        },
        {
          astId: 7,
          contract: "contracts/Exchange.sol:Exchange",
          label: "baseLotExp",
          offset: 20,
          slot: "1",
          type: "t_uint8",
        },
        {
          astId: 8,
          contract: "contracts/Exchange.sol:Exchange",
          label: "quoteLotExp",
          offset: 21,
          slot: "1",
          type: "t_uint8",
        },
        {
          astId: 9,
          contract: "contracts/Exchange.sol:Exchange",
          label: "bids",
          offset: 0,
          slot: "2",
          type: "t_mapping_uint64_tick",
        },
        {
          astId: 10,
          contract: "contracts/Exchange.sol:Exchange",
          label: "asks",
          offset: 0,
          slot: "3",
          type: "t_mapping_uint64_tick",
        },
      ],
      numberOfBytes: "128",
    },
    t_struct_tick: {
      encoding: "inplace",
      label: "struct Tick",
      members: [
        {
          astId: 11,
          contract: "contracts/Exchange.sol:Exchange",
          label: "quantity",
          offset: 0,
          slot: "0",
          type: "t_uint64",
        },
        {
          astId: 12,
          contract: "contracts/Exchange.sol:Exchange",
          label: "remainingQuantity",
          offset: 8,
          slot: "0",
          type: "t_uint64",
        },
        {
          astId: 13,
          contract: "contracts/Exchange.sol:Exchange",
          label: "volume",
          offset: 16,
          slot: "0",
          type: "t_uint32",
        },
      ],
      numberOfBytes: "32",
    },
  },
} as const satisfies StorageLayout;

const sides = ["bids", "asks"] as const;

const accountCount = readPositiveInt("ACCOUNTS", 100);
const assetCount = readPositiveInt("ASSETS", 6);
const nonceBucketCount = readPositiveInt("NONCE_BUCKETS", 8);
const instrumentCount = readPositiveInt("INSTRUMENTS", 4);
const priceLevelsPerSide = readPositiveInt("PRICE_LEVELS_PER_SIDE", 250);
const iterations = readPositiveInt("ITERATIONS", 25);
const warmupIterations = readPositiveInt("WARMUP_ITERATIONS", 3);
const growthIterations = readPositiveInt("GROWTH_ITERATIONS", 5);

const accounts = Array.from({ length: accountCount }, (_, index) =>
  hex(index + 1, 32),
);
const assets = Array.from({ length: assetCount }, (_, index) =>
  hex(index + 1, 20),
);
const knownPaths = buildKnownPaths();

const state = createOrderBookLikeState(knownPaths);

const stableResults = [
  bench("market-side Object.keys + sort", iterations, (index) => {
    const instrumentId = (index % instrumentCount) + 1;
    const side = sides[index % sides.length]!;
    return enumerateMarketSide(state, instrumentId, side);
  }),
  bench("account balances Object.keys", iterations, (index) => {
    const account = accounts[index % accounts.length]!;
    return Object.keys(state.accounts[account]!.balances).length;
  }),
  bench("account nonces Object.keys", iterations, (index) => {
    const account = accounts[index % accounts.length]!;
    return Object.keys(state.accounts[account]!.nonces).length;
  }),
  bench("mixed production enumeration", iterations, (index) => {
    const account = accounts[index % accounts.length]!;
    const instrumentId = (index % instrumentCount) + 1;
    return (
      enumerateMarketSide(state, instrumentId, "bids") +
      enumerateMarketSide(state, instrumentId, "asks") +
      Object.keys(state.accounts[account]!.balances).length +
      Object.keys(state.accounts[account]!.nonces).length
    );
  }),
];

const growingKnownPaths = knownPaths.slice();
const growingState = createOrderBookLikeState(growingKnownPaths);
const growthResult = bench(
  "market-side after knownPaths growth",
  growthIterations,
  (index) => {
    const account = accounts[index % accounts.length]!;
    const nextNonceBucket = nonceBucketCount + index;
    growingKnownPaths.push(`accounts[${account}].nonces[${nextNonceBucket}]`);
    return enumerateMarketSide(growingState, 1, "asks");
  },
);

console.log(
  JSON.stringify(
    {
      config: {
        accountCount,
        assetCount,
        nonceBucketCount,
        instrumentCount,
        priceLevelsPerSide,
        knownPathCount: knownPaths.length,
        iterations,
        warmupIterations,
        growthIterations,
      },
      results: [...stableResults, growthResult],
    },
    null,
    2,
  ),
);

function buildKnownPaths(): string[] {
  const paths: string[] = [];

  for (const account of accounts) {
    for (let nonceBucket = 0; nonceBucket < nonceBucketCount; nonceBucket++) {
      paths.push(`accounts[${account}].nonces[${nonceBucket}]`);
    }
    for (const asset of assets) {
      paths.push(`accounts[${account}].balances[${asset}]`);
    }
  }

  for (let instrumentId = 1; instrumentId <= instrumentCount; instrumentId++) {
    for (const side of sides) {
      for (let level = 0; level < priceLevelsPerSide; level++) {
        const price = priceFor(instrumentId, side, level);
        paths.push(`instruments[${instrumentId}].${side}[${price}].quantity`);
        paths.push(
          `instruments[${instrumentId}].${side}[${price}].remainingQuantity`,
        );
        paths.push(`instruments[${instrumentId}].${side}[${price}].volume`);
      }
    }
  }

  return paths;
}

function createOrderBookLikeState(paths: string[]): OrderBookLikeState {
  const get = (_slots: Hex.Hex[]): Record<Hex.Hex, Hex.Hex> => {
    throw new Error("known-path enumeration benchmark should not read slots");
  };
  return createStorageProxy(
    layout,
    get,
    paths,
  ) as unknown as OrderBookLikeState;
}

function enumerateMarketSide(
  state: OrderBookLikeState,
  instrumentId: number,
  side: Side,
): number {
  const ticks = state.instruments[`${instrumentId}`]![side];
  const prices = Object.keys(ticks).map(Number);
  prices.sort((a, b) => (side === "asks" ? a - b : b - a));
  return prices.length + (prices[0] ?? 0) + (prices.at(-1) ?? 0);
}

function bench(
  name: string,
  count: number,
  run: (index: number) => number,
): {
  readonly name: string;
  readonly iterations: number;
  readonly totalMs: number;
  readonly avgUs: number;
  readonly opsPerSecond: number;
  readonly checksum: number;
} {
  let checksum = 0;
  for (let i = 0; i < warmupIterations; i++) {
    checksum += run(i);
  }

  const startedAt = performance.now();
  for (let i = 0; i < count; i++) {
    checksum += run(i);
  }
  const totalMs = performance.now() - startedAt;

  return {
    name,
    iterations: count,
    totalMs: round(totalMs, 2),
    avgUs: round((totalMs * 1_000) / count, 2),
    opsPerSecond: round(count / (totalMs / 1_000), 2),
    checksum,
  };
}

function priceFor(instrumentId: number, side: Side, level: number): number {
  const sideOffset = side === "asks" ? 500_000 : 0;
  return 1_000_000_000 + instrumentId * 10_000_000 + sideOffset + level * 100;
}

function hex(index: number, byteLength: number): HexString {
  return `0x${index.toString(16).padStart(byteLength * 2, "0")}`;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received '${raw}'`);
  }
  return value;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
