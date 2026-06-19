import {
  fromLots,
  INSTRUMENTS,
  type InstrumentConfig,
  priceToQ32,
  TokenAmount,
} from "order-book-sdk";
import type { Abi, Hex } from "viem";
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseSignature,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import Exchange from "../contracts/src/Exchange.sol";
import { CHAIN_ID, EXCHANGE_ADDRESS, requiredEnv } from "./src/constants";
import {
  type Account,
  createAccount,
  deposit,
  limitOrder,
  sign,
} from "./src/sdk";

const RPC_URL = requiredEnv("RPC_URL", process.env.RPC_URL);

const BASELINE_N = 10;
const SETTLE_MS = 1000;

const FAR_DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 86400);

const PRIVATE_KEY = requiredEnv(
  "PRIVATE_KEY",
  process.env.PRIVATE_KEY,
) as `0x${string}`;
const SCHEDULER_ADDRESS = privateKeyToAccount(PRIVATE_KEY).address;

enum MutationType {
  CloseOrder = 3,
  ChangeOrder = 4,
  LimitOrder = 5,
  MarketOrder = 6,
}

const publicClient = createPublicClient({ transport: http(RPC_URL) });
const exchangeArtifactPath = Exchange.replace(
  /src\/Exchange\.sol$/,
  "out/Exchange.sol/Exchange.json",
);
const exchangeArtifact = (await Bun.file(exchangeArtifactPath).json()) as {
  abi: Abi;
};

// Pick a small integer human price, small enough that tests won't need
// huge deposits and unlikely to collide with live orderbook activity.
function randomHumanPrice(): number {
  return 1 + Math.floor(Math.random() * 1_000_000);
}

type BatchArg = {
  mutations: number[];
  mutationData: Hex[];
  signatureData: Hex[];
};

type Mut =
  | {
      type: MutationType.LimitOrder;
      quantity: bigint;
      instrumentId: number;
      price: bigint;
      bidOrAsk: 0 | 1;
      nonce: bigint;
      deadline: bigint;
    }
  | {
      type: MutationType.MarketOrder;
      quantity: bigint;
      minReceivedQuantity: bigint;
      instrumentId: number;
      bidOrAsk: 0 | 1;
      nonce: bigint;
      deadline: bigint;
    }
  | {
      type: MutationType.CloseOrder;
      orderId: number;
      nonce: bigint;
      deadline: bigint;
    }
  | {
      type: MutationType.ChangeOrder;
      orderId: number;
      price: bigint;
      nonce: bigint;
      deadline: bigint;
    };

function encodeMutationData(m: Mut): Hex {
  switch (m.type) {
    case MutationType.LimitOrder:
      return encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { type: "uint256", name: "quantity" },
              { type: "uint64", name: "instrumentId" },
              { type: "uint64", name: "price" },
              { type: "uint8", name: "bidOrAsk" },
              { type: "uint256", name: "nonce" },
              { type: "uint256", name: "deadline" },
            ],
          },
        ],
        [
          {
            quantity: m.quantity,
            instrumentId: BigInt(m.instrumentId),
            price: m.price,
            bidOrAsk: m.bidOrAsk,
            nonce: m.nonce,
            deadline: m.deadline,
          },
        ],
      );
    case MutationType.MarketOrder:
      return encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { type: "uint256", name: "quantity" },
              { type: "uint256", name: "minReceivedQuantity" },
              { type: "uint64", name: "instrumentId" },
              { type: "uint8", name: "bidOrAsk" },
              { type: "uint256", name: "nonce" },
              { type: "uint256", name: "deadline" },
            ],
          },
        ],
        [
          {
            quantity: m.quantity,
            minReceivedQuantity: m.minReceivedQuantity,
            instrumentId: BigInt(m.instrumentId),
            bidOrAsk: m.bidOrAsk,
            nonce: m.nonce,
            deadline: m.deadline,
          },
        ],
      );
    case MutationType.CloseOrder:
      return encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { type: "uint64", name: "orderId" },
              { type: "uint256", name: "nonce" },
              { type: "uint256", name: "deadline" },
            ],
          },
        ],
        [
          {
            orderId: BigInt(m.orderId),
            nonce: m.nonce,
            deadline: m.deadline,
          },
        ],
      );
    case MutationType.ChangeOrder:
      return encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { type: "uint64", name: "orderId" },
              { type: "uint64", name: "price" },
              { type: "uint256", name: "nonce" },
              { type: "uint256", name: "deadline" },
            ],
          },
        ],
        [
          {
            orderId: BigInt(m.orderId),
            price: m.price,
            nonce: m.nonce,
            deadline: m.deadline,
          },
        ],
      );
  }
}

function signMutation(account: Account, m: Mut): Hex {
  switch (m.type) {
    case MutationType.LimitOrder:
      return sign(account.privateKey, "LimitOrder", {
        quantity: m.quantity,
        instrumentId: BigInt(m.instrumentId),
        price: m.price,
        bidOrAsk: m.bidOrAsk,
        nonce: m.nonce,
        deadline: m.deadline,
      });
    case MutationType.MarketOrder:
      return sign(account.privateKey, "MarketOrder", {
        quantity: m.quantity,
        minReceivedQuantity: m.minReceivedQuantity,
        instrumentId: BigInt(m.instrumentId),
        bidOrAsk: m.bidOrAsk,
        nonce: m.nonce,
        deadline: m.deadline,
      });
    case MutationType.CloseOrder:
      return sign(account.privateKey, "CloseOrder", {
        orderId: BigInt(m.orderId),
        nonce: m.nonce,
        deadline: m.deadline,
      });
    case MutationType.ChangeOrder:
      return sign(account.privateKey, "ChangeOrder", {
        orderId: BigInt(m.orderId),
        price: m.price,
        nonce: m.nonce,
        deadline: m.deadline,
      });
  }
}

function reencodeSig(raw: Hex): Hex {
  if (raw.length === 132) {
    const { v, r, s } = parseSignature(raw);
    return encodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
      [Number(v), r, s],
    );
  }
  return raw;
}

function encodeSignature(account: Account, rawSignature: Hex): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { type: "bytes32", name: "account" },
          { type: "uint64", name: "keyId" },
          { type: "bytes", name: "rawSignature" },
        ],
      },
    ],
    [
      {
        account: account.accountHex,
        keyId: BigInt(account.keyId),
        rawSignature,
      },
    ],
  );
}

function buildBatch(account: Account, muts: Mut[]): BatchArg {
  return {
    mutations: muts.map((m) => m.type),
    mutationData: muts.map(encodeMutationData),
    signatureData: muts.map((m) =>
      encodeSignature(account, reencodeSig(signMutation(account, m))),
    ),
  };
}

async function estimate(batch: BatchArg): Promise<bigint> {
  const data = encodeFunctionData({
    abi: exchangeArtifact.abi,
    functionName: "execute",
    args: [[batch], []],
  });
  const { accessList } = await publicClient.createAccessList({
    account: SCHEDULER_ADDRESS,
    to: EXCHANGE_ADDRESS,
    data,
  });
  return publicClient.estimateGas({
    account: SCHEDULER_ADDRESS,
    to: EXCHANGE_ADDRESS,
    data,
    accessList,
  });
}

async function marginalGas(
  account: Account,
  baseline: Mut[],
  extra: Mut,
): Promise<bigint> {
  const base = buildBatch(account, baseline);
  const plus = buildBatch(account, [...baseline, extra]);
  const [gBase, gPlus] = await Promise.all([estimate(base), estimate(plus)]);
  return gPlus - gBase;
}

function nonceFor(account: Account, offset: bigint): bigint {
  return (account.nonceKey << 64n) | (account.seq + offset);
}

async function setupAccount(
  instrument: InstrumentConfig,
  baseLots: bigint,
  quoteLots: bigint,
): Promise<Account> {
  const account = await createAccount();
  if (baseLots > 0n) {
    await deposit(account, {
      quantity: TokenAmount.fromRaw(
        fromLots(baseLots, instrument.baseLotExp),
        instrument.base,
      ),
    });
  }
  if (quoteLots > 0n) {
    await deposit(account, {
      quantity: TokenAmount.fromRaw(
        fromLots(quoteLots, instrument.quoteLotExp),
        instrument.quote,
      ),
    });
  }
  return account;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

const instrument = INSTRUMENTS["GOLD/USD"];

console.log(
  `measuring marginal gas costs against ${EXCHANGE_ADDRESS} on chain ${CHAIN_ID}`,
);
console.log(`rpc: ${RPC_URL}`);
console.log(`scheduler (from private key): ${SCHEDULER_ADDRESS}`);
console.log(`baseline batch size N = ${BASELINE_N}`);
console.log("");

// Scenario 1: limit order on a fresh tick
{
  const basePrice = randomHumanPrice();
  const account = await setupAccount(instrument, 0n, 1_000_000_000_000n);
  await sleep(SETTLE_MS);

  const mkLimit = (i: number): Mut => ({
    type: MutationType.LimitOrder,
    quantity: 1n << BigInt(instrument.baseLotExp),
    instrumentId: instrument.id,
    price: priceToQ32(basePrice + i, instrument),
    bidOrAsk: 0,
    nonce: nonceFor(account, BigInt(i)),
    deadline: FAR_DEADLINE,
  });

  const baseline = Array.from({ length: BASELINE_N }, (_, i) => mkLimit(i));
  const extra = mkLimit(BASELINE_N);
  const gas = await marginalGas(account, baseline, extra);
  console.log(`limit order (fresh tick):       ${gas} gas`);
}

// Scenario 2: limit order on a used tick
{
  const price = randomHumanPrice();
  const q32 = priceToQ32(price, instrument);
  const account = await setupAccount(instrument, 0n, 1_000_000_000_000n);
  // Seed the tick with one existing order so baseline mutations hit a warm, populated tick.
  await limitOrder(account, {
    instrument,
    price,
    side: "buy",
    quantity: TokenAmount.fromRaw(
      fromLots(1n, instrument.baseLotExp),
      instrument.base,
    ),
  });
  await sleep(SETTLE_MS);

  const mkLimit = (i: number): Mut => ({
    type: MutationType.LimitOrder,
    quantity: 1n << BigInt(instrument.baseLotExp),
    instrumentId: instrument.id,
    price: q32,
    bidOrAsk: 0,
    nonce: nonceFor(account, BigInt(i)),
    deadline: FAR_DEADLINE,
  });

  const baseline = Array.from({ length: BASELINE_N }, (_, i) => mkLimit(i));
  const extra = mkLimit(BASELINE_N);
  const gas = await marginalGas(account, baseline, extra);
  console.log(`limit order (used tick):        ${gas} gas`);
}

// Scenario 3: market order, no cross (all fills at one price)
{
  const price = randomHumanPrice();
  // Seed a large ask at `price` so many market buys drain from the same tick.
  const maker = await setupAccount(instrument, 1_000n, 0n);
  await limitOrder(maker, {
    instrument,
    price,
    side: "sell",
    quantity: TokenAmount.fromRaw(
      fromLots(1_000n, instrument.baseLotExp),
      instrument.base,
    ),
  });

  const taker = await setupAccount(instrument, 0n, 1_000_000_000_000n);
  await sleep(SETTLE_MS);

  const mkMarket = (i: number): Mut => ({
    type: MutationType.MarketOrder,
    quantity: 1n << BigInt(instrument.baseLotExp),
    minReceivedQuantity: 1n << BigInt(instrument.baseLotExp),
    instrumentId: instrument.id,
    bidOrAsk: 0,
    nonce: nonceFor(taker, BigInt(i)),
    deadline: FAR_DEADLINE,
  });

  const baseline = Array.from({ length: BASELINE_N }, (_, i) => mkMarket(i));
  const extra = mkMarket(BASELINE_N);
  const gas = await marginalGas(taker, baseline, extra);
  console.log(`market order (no cross):        ${gas} gas`);
}

// Scenario 4: market order, crosses 3 ticks
{
  const p0 = randomHumanPrice();
  const prices = [p0, p0 + 1, p0 + 2];
  const maker = await setupAccount(instrument, 3_000n, 0n);
  for (const p of prices) {
    await limitOrder(maker, {
      instrument,
      price: p,
      side: "sell",
      quantity: TokenAmount.fromRaw(
        fromLots(1_000n, instrument.baseLotExp),
        instrument.base,
      ),
    });
  }

  const taker = await setupAccount(instrument, 0n, 1_000_000_000_000n);
  await sleep(SETTLE_MS);

  const mkMarket = (i: number): Mut => ({
    type: MutationType.MarketOrder,
    quantity: 3n << BigInt(instrument.baseLotExp),
    minReceivedQuantity: 3n << BigInt(instrument.baseLotExp),
    instrumentId: instrument.id,
    bidOrAsk: 0,
    nonce: nonceFor(taker, BigInt(i)),
    deadline: FAR_DEADLINE,
  });

  const baseline = Array.from({ length: BASELINE_N }, (_, i) => mkMarket(i));
  const extra = mkMarket(BASELINE_N);
  const gas = await marginalGas(taker, baseline, extra);
  console.log(`market order (crosses 3 ticks): ${gas} gas`);
}

// Scenario 5: close order
{
  const account = await setupAccount(instrument, 0n, 1_000_000_000_000n);
  // Pre-place BASELINE_N + 1 limits so we have orders to close.
  for (let i = 0; i < BASELINE_N + 1; i++) {
    const p = randomHumanPrice();
    await limitOrder(account, {
      instrument,
      price: p,
      side: "buy",
      quantity: TokenAmount.fromRaw(
        fromLots(1n, instrument.baseLotExp),
        instrument.base,
      ),
    });
  }
  await sleep(SETTLE_MS);

  const mkClose = (i: number): Mut => ({
    type: MutationType.CloseOrder,
    orderId: i,
    nonce: nonceFor(account, BigInt(i)),
    deadline: FAR_DEADLINE,
  });

  const baseline = Array.from({ length: BASELINE_N }, (_, i) => mkClose(i));
  const extra = mkClose(BASELINE_N);
  const gas = await marginalGas(account, baseline, extra);
  console.log(`close order:                    ${gas} gas`);
}
