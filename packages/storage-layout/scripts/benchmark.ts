// Read patterns of `apps/order-book` against its storage layout, through an
// async getter over in-memory storage, like the typewriter runtime's slot
// cache. Times are storage-layout CPU only. Compare against `main` on the same
// machine.
//
//   bun run benchmark
//   BENCH_ACCOUNTS=5000 BENCH_TICKS=500 bun run benchmark
//   BENCH_CASE=depth bun --cpu-prof-md scripts/benchmark.ts  # profile one case

import { Hash, Hex } from "ox";
import {
  type AccountStorage,
  createStorageView,
  decodeStorageVariable,
  enumerateMappingKeys,
  type KeccakPreimage,
} from "../src/index";
import { encodeMappingKey, toWord } from "../src/solidity-encoding";
import {
  findStorageType,
  isMappingType,
  resolveStoragePath,
} from "../src/storage-layout";
import { readSubscript } from "../src/storage-path";
import { OrderBookFixture } from "../test/contracts/generated";
import { bytesStorage } from "../test/utils";

const ACCOUNTS = readPositiveInt("BENCH_ACCOUNTS", 1_000);
const TICKS = readPositiveInt("BENCH_TICKS", 200);
const ORDERS = readPositiveInt("BENCH_ORDERS", 50);
const ASSETS = 3;
const NONCES = 3;
const MIN_TIME_MS = readPositiveInt("BENCH_MIN_TIME_MS", 500);
const { BENCH_CASE: CASE } = Bun.env;

const layout = OrderBookFixture.storageLayout;

// Storage and preimages, as the runtime holds them after the writes below.
const words = new Map<Hex.Hex, bigint>();
const preimages: KeccakPreimage[] = [];
const preimageSet = new Set<Hex.Hex>();

/** Record the mapping preimages of `path`, as the runtime does for known paths. */
function touch(path: string) {
  for (let index = path.indexOf("["); index !== -1; ) {
    const { type, slot } = resolveStoragePath(layout, path.slice(0, index));
    const subscript = readSubscript(path, index);
    index = path.indexOf("[", subscript.next);
    if (isMappingType(type) === false) continue;
    const key = encodeMappingKey(
      findStorageType(layout, type.key),
      subscript.value,
      path,
    );
    const preimage = Hex.concat(key, toWord(slot));
    if (preimageSet.has(preimage)) continue;
    preimageSet.add(preimage);
    preimages.push({ hash: Hash.keccak256(preimage), preimage });
  }
}

function write(path: string, value: bigint) {
  touch(path);
  const { slot, offset, type } = resolveStoragePath(layout, path);
  const shift = BigInt(offset * 8);
  const mask = ((1n << BigInt(Number(type.numberOfBytes) * 8)) - 1n) << shift;
  const word = words.get(toWord(slot)) ?? 0n;
  words.set(toWord(slot), (word & ~mask) | ((value << shift) & mask));
}

function writeBytes(path: string, value: Hex.Hex) {
  touch(path);
  const { slot } = resolveStoragePath(layout, path);
  for (const [key, word] of Object.entries(bytesStorage(toWord(slot), value))) {
    words.set(key as Hex.Hex, BigInt(word));
  }
}

const accountId = (index: number) => Hex.fromNumber(index + 1, { size: 32 });
const asset = (index: number) => Hex.fromNumber(0xa000 + index, { size: 20 });
const TRADER = accountId(0);
const MID = 3000n << 32n;
const STEP = MID / 10_000n; // 1 basis point
const bidPrice = (index: number) => MID - BigInt(index + 1) * STEP;
const askPrice = (index: number) => MID + BigInt(index + 1) * STEP;

for (let index = 0; index < ACCOUNTS; index++) {
  const id = accountId(index);
  for (let a = 0; a < ASSETS; a++) {
    write(
      `state.accounts[${id}].balances[${asset(a)}]`,
      1_000_000n + BigInt(a),
    );
  }
  const orders = index === 0 ? ORDERS : 2;
  write(`state.accounts[${id}].orders`, BigInt(orders));
  for (let o = 0; o < orders; o++) {
    const order = `state.accounts[${id}].orders[${o}]`;
    write(`${order}.quantity`, 10n);
    write(`${order}.instrumentId`, 1n);
    write(`${order}.price`, bidPrice(o % TICKS));
    write(`${order}.tickVolume`, 3n);
    write(`${order}.side`, BigInt(o % 2));
  }
  write(`accounts[${id}].credentials`, 1n);
  write(`accounts[${id}].credentials[0].expiration`, 2n ** 39n);
  write(`accounts[${id}].credentials[0].keyType`, 1n);
  write(`accounts[${id}].credentials[0].permissions`, 2n ** 255n);
  writeBytes(
    `accounts[${id}].credentials[0].publicKey`,
    `0x04${"ab".repeat(64)}`,
  );
  write(`accounts[${id}].activeCredentials`, 1n);
  for (let n = 0; n < NONCES; n++) {
    write(`accounts[${id}].nonces[${n}]`, BigInt(n + 1));
  }
}

write("state.instruments[1].base", BigInt(asset(0)));
write("state.instruments[1].quote", BigInt(asset(1)));
write("state.instruments[1].bestBid", bidPrice(0));
write("state.instruments[1].bestAsk", askPrice(0));
for (const [side, price] of [
  ["bids", bidPrice],
  ["asks", askPrice],
] as const) {
  for (let index = 0; index < TICKS; index++) {
    const tick = `state.instruments[1].${side}[${price(index)}]`;
    write(`${tick}.quantity`, 100n);
    write(`${tick}.remainingQuantity`, index === 0 ? 0n : 100n);
    write(`${tick}.volume`, 4n);
    write(`${tick}.prev`, index === 0 ? 0n : price(index - 1));
    write(`${tick}.next`, index === TICKS - 1 ? 0n : price(index + 1));
  }
}

const storage = new Map([...words].map(([slot, word]) => [slot, toWord(word)]));
const ZERO = toWord(0n);
let getterCalls = 0;
let slotsRead = 0;
const view = createStorageView(
  layout,
  async (slots: readonly Hex.Hex[]) => {
    getterCalls++;
    slotsRead += slots.length;
    return slots.map((slot) => storage.get(slot) ?? ZERO);
  },
  preimages,
);
const app = { state: view.state, accounts: view.accounts };

// --- apps/order-book/src/index.ts read helpers --------------------------------

async function accountCredentials(account: Hex.Hex) {
  const credentials = app.accounts[account]!.credentials;
  const length = await credentials.length;
  const out = [];
  for (let i = 0; i < length; i++) {
    const credential = credentials[i]!;
    out.push(
      await Promise.all([
        credential.expiration,
        credential.keyType,
        credential.permissions,
        credential.publicKey,
      ]),
    );
  }
  return out;
}

async function accountOrders(account: Hex.Hex) {
  const orders = app.state.accounts[account]!.orders;
  const length = await orders.length;
  const out = [];
  for (let i = 0; i < length; i++) {
    const order = orders[i]!;
    out.push(
      await Promise.all([
        order.quantity,
        order.instrumentId,
        order.price,
        order.tickVolume,
        order.side,
      ]),
    );
  }
  return out;
}

async function accountBalances(account: Hex.Hex) {
  const balances = app.state.accounts[account]!.balances;
  const out: Record<string, bigint> = {};
  for (const key of Object.keys(balances) as Hex.Hex[]) {
    out[key] = await balances[key]!;
  }
  return out;
}

async function accountNonces(account: Hex.Hex) {
  const nonces = app.accounts[account]!.nonces;
  const out: Record<string, bigint> = {};
  for (const key of Object.keys(nonces) as `${number}`[]) {
    out[key] = await nonces[key]!;
  }
  return out;
}

async function getPrices(side: "bids" | "asks") {
  const instrument = app.state.instruments["1"]!;
  const prices: bigint[] = [];
  let price = await (side === "asks" ? instrument.bestAsk : instrument.bestBid);
  while (price !== 0n) {
    prices.push(price);
    price = await instrument[side][`${price}` as `${number}`]!.next;
  }
  return prices;
}

async function depth() {
  const bids = await getPrices("bids");
  const asks = await getPrices("asks");
  const remaining = (side: "bids" | "asks", price: bigint) =>
    app.state.instruments["1"]![side][`${price}` as `${number}`]!
      .remainingQuantity;
  let bestBid = 0n;
  for (const price of bids) {
    if ((await remaining("bids", price)) > 0n) {
      bestBid = price;
      break;
    }
  }
  let bestAsk = 0n;
  for (const price of asks) {
    if ((await remaining("asks", price)) > 0n) {
      bestAsk = price;
      break;
    }
  }
  const mid = (bestBid + bestAsk) / 2n;
  for (const bp of [1n, 5n, 25n]) {
    for (const price of bids) {
      if (price >= mid - (mid * bp) / 10_000n) await remaining("bids", price);
    }
    for (const price of asks) {
      if (price <= mid + (mid * bp) / 10_000n) await remaining("asks", price);
    }
  }
}

async function ticks(count: number) {
  return Promise.all(
    Array.from({ length: count }, (_, index) => {
      const tick =
        app.state.instruments["1"]!.bids[`${bidPrice(index)}` as `${number}`]!;
      return Promise.all([tick.quantity, tick.remainingQuantity, tick.volume]);
    }),
  );
}

// --- Cases ---------------------------------------------------------------------

const raw: AccountStorage = Object.fromEntries(storage);
const results = [
  await bench("decodeStorageVariable: uint64 field", () =>
    decodeStorageVariable(layout, `state.instruments[1].bestBid`, raw),
  ),
  await bench(
    "view: one struct field (tick.remainingQuantity)",
    () =>
      app.state.instruments["1"]!.bids[`${bidPrice(3)}` as `${number}`]!
        .remainingQuantity,
  ),
  await bench("/api/orders: accountOrders", () => accountOrders(TRADER)),
  await bench("/api/account: accountCredentials", () =>
    accountCredentials(TRADER),
  ),
  await bench("/api/account: accountBalances (Object.keys)", () =>
    accountBalances(TRADER),
  ),
  await bench("/api/account: accountNonces (Object.keys)", () =>
    accountNonces(TRADER),
  ),
  await bench("/api/price: getPrices both sides", async () => {
    await getPrices("bids");
    await getPrices("asks");
  }),
  await bench("/api/depth", depth),
  await bench("/api/ticks: 50 ticks", () => ticks(50)),
  await bench("token /api/accountIds: Object.keys(state.accounts)", () =>
    Object.keys(app.state.accounts),
  ),
  await bench("enumerateMappingKeys(state.accounts)", () =>
    enumerateMappingKeys(layout, "state.accounts", preimages),
  ),
];

console.log(
  `${ACCOUNTS} accounts, ${TICKS} ticks per side, ${ORDERS} orders, ${preimages.length} preimages`,
);
console.table(results.filter((result) => result !== undefined));

/**
 * Mean time of `fn` over at least `MIN_TIME_MS`, after one warm-up call, with
 * the getter calls and slots read per call.
 */
async function bench(name: string, fn: () => unknown) {
  if (CASE !== undefined && name.includes(CASE) === false) return undefined;
  await fn();
  getterCalls = 0;
  slotsRead = 0;
  let iterations = 0;
  const startedAt = performance.now();
  let elapsed = 0;
  while (elapsed < MIN_TIME_MS || iterations < 3) {
    await fn();
    iterations++;
    elapsed = performance.now() - startedAt;
  }
  const meanMs = elapsed / iterations;
  const reads = getterCalls / iterations;
  return {
    case: name,
    iterations,
    "mean (ms)": Number(meanMs.toFixed(3)),
    "getter calls": Math.round(reads),
    "slots read": Math.round(slotsRead / iterations),
    "µs per getter call":
      reads === 0 ? "-" : Number(((meanMs * 1000) / reads).toFixed(1)),
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
