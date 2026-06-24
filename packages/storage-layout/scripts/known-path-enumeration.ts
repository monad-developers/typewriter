import type { StorageLayout } from "../src";

type HexString = `0x${string}`;
type Side = "bids" | "asks";

type KnownPathIndex = {
  readonly accountBalances: Map<HexString, Set<HexString>>;
  readonly accountNonces: Map<HexString, Set<string>>;
  readonly marketSides: Map<string, Set<number>>;
};

const layout = {
  storage: [
    {
      astId: 1,
      contract: "contracts/OrderBook.sol:OrderBook",
      label: "accounts",
      offset: 0,
      slot: "0",
      type: "t_mapping_bytes32_account",
    },
    {
      astId: 2,
      contract: "contracts/OrderBook.sol:OrderBook",
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
          contract: "contracts/OrderBook.sol:OrderBook",
          label: "nonces",
          offset: 0,
          slot: "0",
          type: "t_mapping_uint192_uint64",
        },
        {
          astId: 4,
          contract: "contracts/OrderBook.sol:OrderBook",
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
          contract: "contracts/OrderBook.sol:OrderBook",
          label: "base",
          offset: 0,
          slot: "0",
          type: "t_address",
        },
        {
          astId: 6,
          contract: "contracts/OrderBook.sol:OrderBook",
          label: "quote",
          offset: 0,
          slot: "1",
          type: "t_address",
        },
        {
          astId: 7,
          contract: "contracts/OrderBook.sol:OrderBook",
          label: "baseLotExp",
          offset: 20,
          slot: "1",
          type: "t_uint8",
        },
        {
          astId: 8,
          contract: "contracts/OrderBook.sol:OrderBook",
          label: "quoteLotExp",
          offset: 21,
          slot: "1",
          type: "t_uint8",
        },
        {
          astId: 9,
          contract: "contracts/OrderBook.sol:OrderBook",
          label: "bids",
          offset: 0,
          slot: "2",
          type: "t_mapping_uint64_tick",
        },
        {
          astId: 10,
          contract: "contracts/OrderBook.sol:OrderBook",
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
          contract: "contracts/OrderBook.sol:OrderBook",
          label: "quantity",
          offset: 0,
          slot: "0",
          type: "t_uint64",
        },
        {
          astId: 12,
          contract: "contracts/OrderBook.sol:OrderBook",
          label: "remainingQuantity",
          offset: 8,
          slot: "0",
          type: "t_uint64",
        },
        {
          astId: 13,
          contract: "contracts/OrderBook.sol:OrderBook",
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
void layout;

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
const knownPathIndex = buildKnownPathIndex(knownPaths);

const stableResults = [
  bench("market-side explicit index + sort", iterations, (index) => {
    const instrumentId = (index % instrumentCount) + 1;
    const side = sides[index % sides.length]!;
    return enumerateMarketSide(knownPathIndex, instrumentId, side);
  }),
  bench("account balances explicit index", iterations, (index) => {
    const account = accounts[index % accounts.length]!;
    return knownPathIndex.accountBalances.get(account)?.size ?? 0;
  }),
  bench("account nonces explicit index", iterations, (index) => {
    const account = accounts[index % accounts.length]!;
    return knownPathIndex.accountNonces.get(account)?.size ?? 0;
  }),
  bench("mixed explicit index enumeration", iterations, (index) => {
    const account = accounts[index % accounts.length]!;
    const instrumentId = (index % instrumentCount) + 1;
    return (
      enumerateMarketSide(knownPathIndex, instrumentId, "bids") +
      enumerateMarketSide(knownPathIndex, instrumentId, "asks") +
      (knownPathIndex.accountBalances.get(account)?.size ?? 0) +
      (knownPathIndex.accountNonces.get(account)?.size ?? 0)
    );
  }),
];

const growingKnownPaths = knownPaths.slice();
const growingKnownPathIndex = buildKnownPathIndex(growingKnownPaths);
const growthResult = bench(
  "market-side explicit index after growth",
  growthIterations,
  (index) => {
    const account = accounts[index % accounts.length]!;
    const nextNonceBucket = nonceBucketCount + index;
    const path = `accounts[${account}].nonces[${nextNonceBucket}]`;
    growingKnownPaths.push(path);
    addKnownPath(growingKnownPathIndex, path);
    return enumerateMarketSide(growingKnownPathIndex, 1, "asks");
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

function enumerateMarketSide(
  index: KnownPathIndex,
  instrumentId: number,
  side: Side,
): number {
  const prices = [
    ...(index.marketSides.get(marketSideKey(instrumentId, side)) ?? []),
  ];
  prices.sort((a, b) => (side === "asks" ? a - b : b - a));
  return prices.length + (prices[0] ?? 0) + (prices.at(-1) ?? 0);
}

function buildKnownPathIndex(paths: readonly string[]): KnownPathIndex {
  const index: KnownPathIndex = {
    accountBalances: new Map(),
    accountNonces: new Map(),
    marketSides: new Map(),
  };
  for (const path of paths) addKnownPath(index, path);
  return index;
}

function addKnownPath(index: KnownPathIndex, path: string): void {
  const balance = /^accounts\[(0x[0-9a-f]+)\]\.balances\[(0x[0-9a-f]+)\]$/.exec(
    path,
  );
  if (balance !== null) {
    addSetValue(
      index.accountBalances,
      balance[1] as HexString,
      balance[2] as HexString,
    );
    return;
  }

  const nonce = /^accounts\[(0x[0-9a-f]+)\]\.nonces\[([0-9]+)\]$/.exec(path);
  if (nonce !== null) {
    addSetValue(index.accountNonces, nonce[1] as HexString, nonce[2]!);
    return;
  }

  const tick = /^instruments\[([0-9]+)\]\.(bids|asks)\[([0-9]+)\]\./.exec(path);
  if (tick !== null) {
    addSetValue(
      index.marketSides,
      marketSideKey(Number(tick[1]), tick[2] as Side),
      Number(tick[3]),
    );
  }
}

function addSetValue<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key);
  if (set === undefined) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function marketSideKey(instrumentId: number, side: Side): string {
  return `${instrumentId}:${side}`;
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
