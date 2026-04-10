import { beforeEach, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { privateKeyToAccount, signTypedData } from "viem/accounts";
import { anvil } from "viem/chains";
import {
  createState,
  MutationType,
  type State,
  type TaggedMutation,
} from "./exchange";
import { resolveAndOrderMutations } from "./resolution";
import { type RuntimeHandle, startRuntime } from "./runtime";

const SCHEDULER_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const MAKER_PK =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const TAKER_PK =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

const SCHEDULER_ACCOUNT = privateKeyToAccount(SCHEDULER_PK);
const MAKER = privateKeyToAccount(MAKER_PK).address;
const TAKER = privateKeyToAccount(TAKER_PK).address;
const MAKER_ACCOUNT =
  `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
const TAKER_ACCOUNT =
  `0x000000000000000000000000${TAKER.slice(2).toLowerCase()}` as Hex;

const EXCHANGE_ADDRESS =
  "0x0000000000000000000000000000000000000000" as Address;
const BASE: Address = "0x1111111111111111111111111111111111111111";
const QUOTE: Address = "0x2222222222222222222222222222222222222222";
const Q32 = 1n << 32n;
const FAR_DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 86400);

const TEST_CONFIG = {
  flushIntervalMs: 10,
  chain: anvil,
  rpcUrl: "http://localhost:8545",
  account: SCHEDULER_ACCOUNT,
  address: EXCHANGE_ADDRESS,
  rpId: "localhost",
  origin: "http://localhost:3000",
};

const EIP712_DOMAIN = {
  name: "Exchange" as const,
  version: "1" as const,
  chainId: anvil.id,
  verifyingContract: EXCHANGE_ADDRESS,
};

const EIP712_TYPES = {
  CloseOrder: [
    { name: "orderId", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  LimitOrder: [
    { name: "quantity", type: "uint64" },
    { name: "instrumentId", type: "uint64" },
    { name: "price", type: "uint64" },
    { name: "bidOrAsk", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  MarketOrder: [
    { name: "quantity", type: "uint64" },
    { name: "minReceivedQuantity", type: "uint64" },
    { name: "instrumentId", type: "uint64" },
    { name: "bidOrAsk", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Deposit: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Withdrawal: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

function makeKey(addr: Address) {
  return {
    expiry: 0,
    keyType: 2 as const,
    permissions: 0x7f,
    publicKey:
      `0x000000000000000000000000${addr.slice(2).toLowerCase()}` as Hex,
  };
}

function makeAccount(addr: Address, balances: Record<Address, bigint>) {
  return {
    nonces: {},
    balances,
    keys: [makeKey(addr)],
    orders: [] as {
      quantity: bigint;
      instrumentId: number;
      price: bigint;
      tickVolume: number;
      side: 0 | 1;
    }[],
  };
}

async function signDeposit(
  pk: `0x${string}`,
  asset: Address,
  amount: bigint,
  nonce: bigint,
): Promise<`0x${string}`> {
  return signTypedData({
    privateKey: pk,
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: { asset, amount, nonce, deadline: FAR_DEADLINE },
  });
}

async function signLimitOrder(
  pk: `0x${string}`,
  m: { quantity: bigint; instrumentId: number; price: bigint; bidOrAsk: 0 | 1 },
  nonce: bigint,
): Promise<`0x${string}`> {
  return signTypedData({
    privateKey: pk,
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "LimitOrder",
    message: {
      quantity: m.quantity,
      instrumentId: BigInt(m.instrumentId),
      price: m.price,
      bidOrAsk: m.bidOrAsk,
      nonce,
      deadline: FAR_DEADLINE,
    },
  });
}

async function signMarketOrder(
  pk: `0x${string}`,
  m: {
    quantity: bigint;
    minReceivedQuantity: bigint;
    instrumentId: number;
    bidOrAsk: 0 | 1;
  },
  nonce: bigint,
): Promise<`0x${string}`> {
  return signTypedData({
    privateKey: pk,
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "MarketOrder",
    message: {
      quantity: m.quantity,
      minReceivedQuantity: m.minReceivedQuantity,
      instrumentId: BigInt(m.instrumentId),
      bidOrAsk: m.bidOrAsk,
      nonce,
      deadline: FAR_DEADLINE,
    },
  });
}

async function signCloseOrder(
  pk: `0x${string}`,
  orderId: number,
  nonce: bigint,
): Promise<`0x${string}`> {
  return signTypedData({
    privateKey: pk,
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "CloseOrder",
    message: { orderId: BigInt(orderId), nonce, deadline: FAR_DEADLINE },
  });
}

async function signWithdrawal(
  pk: `0x${string}`,
  asset: Address,
  amount: bigint,
  nonce: bigint,
): Promise<`0x${string}`> {
  return signTypedData({
    privateKey: pk,
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "Withdrawal",
    message: { asset, amount, nonce, deadline: FAR_DEADLINE },
  });
}

let state: State<bigint>;
let handle: RuntimeHandle;

beforeEach(async () => {
  state = createState();
  state.instruments[0] = {
    base: BASE,
    baseLotExp: 0,
    quote: QUOTE,
    quoteLotExp: 0,
    bids: {},
    asks: {},
  };

  handle = startRuntime({ ...TEST_CONFIG, initialState: state });
});

test("resolveAndOrderMutations sorts by type and resolves market fills without mutating state", async () => {
  state.accounts[MAKER_ACCOUNT] = makeAccount(MAKER, {
    [QUOTE]: 10000n,
    [BASE]: 0n,
  });
  state.accounts[TAKER_ACCOUNT] = makeAccount(TAKER, {
    [BASE]: 10000n,
    [QUOTE]: 0n,
  });
  state.instruments[0]!.bids[Number(10n * Q32)] = {
    quantity: 100n,
    remainingQuantity: 100n,
    volume: 0,
  };

  const mutations: TaggedMutation[] = [
    {
      type: MutationType.MarketOrder,
      account: TAKER_ACCOUNT,
      keyId: 0,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature: "0x00",
      mutation: {
        quantity: 10n,
        minReceivedQuantity: 0n,
        instrumentId: 0,
        bidOrAsk: 1,
      },
    },
    {
      type: MutationType.LimitOrder,
      account: MAKER_ACCOUNT,
      keyId: 0,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature: "0x00",
      mutation: {
        quantity: 5n,
        instrumentId: 0,
        price: 20n * Q32,
        bidOrAsk: 0,
      },
    },
  ];

  const resolved = resolveAndOrderMutations(state, mutations);

  expect(resolved[0]!.type).toBe(MutationType.LimitOrder);
  expect(resolved[1]!.type).toBe(MutationType.MarketOrder);
  if (resolved[1]!.type === MutationType.MarketOrder) {
    expect(resolved[1]!.resolution.fills.length).toBe(1);
    expect(resolved[1]!.resolution.fills[0]!.quantity).toBe(10n);
  }

  expect(state.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(10000n);
  expect(state.accounts[TAKER_ACCOUNT]!.balances[BASE]).toBe(10000n);
  await handle.stop();
});

test("limit order places on book and locks funds", async () => {
  state.accounts[MAKER_ACCOUNT] = makeAccount(MAKER, {});
  const depSig = await signDeposit(MAKER_PK, QUOTE, 10000n, 0n);
  await handle.execute({
    type: MutationType.Deposit,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: depSig,
    mutation: { asset: QUOTE, amount: 10000n },
  });

  const order = {
    quantity: 10n,
    instrumentId: 0,
    price: 10n * Q32,
    bidOrAsk: 0 as const,
  };
  const sig = await signLimitOrder(MAKER_PK, order, 1n);
  await handle.execute({
    type: MutationType.LimitOrder,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
    mutation: order,
  });

  expect(state.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(9900n);
  expect(state.instruments[0]!.bids[Number(10n * Q32)]!.quantity).toBe(10n);
  await handle.stop();
});

test("market sell fills against resting bid", async () => {
  state.instruments[0]!.bids[Number(10n * Q32)] = {
    quantity: 100n,
    remainingQuantity: 100n,
    volume: 0,
  };

  state.accounts[TAKER_ACCOUNT] = makeAccount(TAKER, {});
  const depSig = await signDeposit(TAKER_PK, BASE, 10000n, 0n);
  await handle.execute({
    type: MutationType.Deposit,
    account: TAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: depSig,
    mutation: { asset: BASE, amount: 10000n },
  });

  const order = {
    quantity: 10n,
    minReceivedQuantity: 0n,
    instrumentId: 0,
    bidOrAsk: 1 as const,
  };
  const sig = await signMarketOrder(TAKER_PK, order, 1n);
  const resolved = await handle.execute({
    type: MutationType.MarketOrder,
    account: TAKER_ACCOUNT,
    keyId: 0,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
    mutation: order,
  });

  expect(state.accounts[TAKER_ACCOUNT]!.balances[BASE]).toBe(9990n);
  expect(state.accounts[TAKER_ACCOUNT]!.balances[QUOTE]).toBe(100n);
  expect(resolved.resolution.fills.length).toBe(1);
  await handle.stop();
});

test("close order refunds unfilled and credits filled", async () => {
  state.instruments[0]!.bids[Number(10n * Q32)] = {
    quantity: 50n,
    remainingQuantity: 30n,
    volume: 0,
  };
  state.accounts[MAKER_ACCOUNT] = {
    ...makeAccount(MAKER, { [QUOTE]: 0n, [BASE]: 0n }),
    orders: [
      {
        quantity: 50n,
        instrumentId: 0,
        price: 10n * Q32,
        tickVolume: 0,
        side: 0,
      },
    ],
  };

  const sig = await signCloseOrder(MAKER_PK, 0, 0n);
  await handle.execute({
    type: MutationType.CloseOrder,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
    mutation: { orderId: 0 },
  });

  expect(state.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(300n);
  expect(state.accounts[MAKER_ACCOUNT]!.balances[BASE]).toBe(20n);
  await handle.stop();
});

test("deposit and withdrawal", async () => {
  state.accounts[MAKER_ACCOUNT] = makeAccount(MAKER, {});
  const depSig = await signDeposit(MAKER_PK, QUOTE, 500n, 0n);
  await handle.execute({
    type: MutationType.Deposit,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: depSig,
    mutation: { asset: QUOTE, amount: 500n },
  });
  expect(state.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(500n);

  const wSig = await signWithdrawal(MAKER_PK, QUOTE, 200n, 1n);
  await handle.execute({
    type: MutationType.Withdrawal,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: wSig,
    mutation: { asset: QUOTE, amount: 200n },
  });
  expect(state.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(300n);
  await handle.stop();
});

test("withdrawal with insufficient balance rejects", async () => {
  state.accounts[MAKER_ACCOUNT] = makeAccount(MAKER, {});
  const sig = await signWithdrawal(MAKER_PK, BASE, 1n, 0n);
  await expect(
    handle.execute({
      type: MutationType.Withdrawal,
      account: MAKER_ACCOUNT,
      keyId: 0,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature: sig,
      mutation: { asset: BASE, amount: 1n },
    }),
  ).rejects.toThrow("InsufficientBalance");
  await handle.stop();
});

test("invalid signature rejects", async () => {
  state.accounts[MAKER_ACCOUNT] = makeAccount(MAKER, {});
  const sig = await signDeposit(TAKER_PK, QUOTE, 500n, 0n);
  await expect(
    handle.execute({
      type: MutationType.Deposit,
      account: MAKER_ACCOUNT,
      keyId: 0,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature: sig,
      mutation: { asset: QUOTE, amount: 500n },
    }),
  ).rejects.toThrow("InvalidSignature");
  await handle.stop();
});

test("expired deadline rejects", async () => {
  state.accounts[MAKER_ACCOUNT] = makeAccount(MAKER, {});
  const expired = BigInt(Math.floor(Date.now() / 1000) - 1);
  const sig = await signDeposit(MAKER_PK, QUOTE, 500n, 0n);
  await expect(
    handle.execute({
      type: MutationType.Deposit,
      account: MAKER_ACCOUNT,
      keyId: 0,
      nonce: 0n,
      deadline: expired,
      rawSignature: sig,
      mutation: { asset: QUOTE, amount: 500n },
    }),
  ).rejects.toThrow("SignatureExpired");
  await handle.stop();
});

test("wrong nonce rejects", async () => {
  state.accounts[MAKER_ACCOUNT] = makeAccount(MAKER, {});
  const sig = await signDeposit(MAKER_PK, QUOTE, 500n, 99n);
  await expect(
    handle.execute({
      type: MutationType.Deposit,
      account: MAKER_ACCOUNT,
      keyId: 0,
      nonce: 99n,
      deadline: FAR_DEADLINE,
      rawSignature: sig,
      mutation: { asset: QUOTE, amount: 500n },
    }),
  ).rejects.toThrow("InvalidNonce");
  await handle.stop();
});

test("full lifecycle: deposit, limit, market, close", async () => {
  const fresh = createState();
  fresh.instruments[0] = {
    base: BASE,
    baseLotExp: 0,
    quote: QUOTE,
    quoteLotExp: 0,
    bids: {},
    asks: {},
  };
  fresh.accounts[MAKER_ACCOUNT] = makeAccount(MAKER, {});
  fresh.accounts[TAKER_ACCOUNT] = makeAccount(TAKER, {});
  const h = startRuntime({ ...TEST_CONFIG, initialState: fresh });

  const makerDepSig = await signDeposit(MAKER_PK, QUOTE, 10000n, 0n);
  await h.execute({
    type: MutationType.Deposit,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: makerDepSig,
    mutation: { asset: QUOTE, amount: 10000n },
  });

  const takerDepSig = await signDeposit(TAKER_PK, BASE, 10000n, 0n);
  await h.execute({
    type: MutationType.Deposit,
    account: TAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: takerDepSig,
    mutation: { asset: BASE, amount: 10000n },
  });

  const limitOrder = {
    quantity: 100n,
    instrumentId: 0,
    price: 10n * Q32,
    bidOrAsk: 0 as const,
  };
  const limitSig = await signLimitOrder(MAKER_PK, limitOrder, 1n);
  await h.execute({
    type: MutationType.LimitOrder,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: limitSig,
    mutation: limitOrder,
  });
  expect(fresh.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(9000n);

  const marketOrder = {
    quantity: 40n,
    minReceivedQuantity: 0n,
    instrumentId: 0,
    bidOrAsk: 1 as const,
  };
  const marketSig = await signMarketOrder(TAKER_PK, marketOrder, 1n);
  await h.execute({
    type: MutationType.MarketOrder,
    account: TAKER_ACCOUNT,
    keyId: 0,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: marketSig,
    mutation: marketOrder,
  });
  expect(fresh.accounts[TAKER_ACCOUNT]!.balances[BASE]).toBe(9960n);
  expect(fresh.accounts[TAKER_ACCOUNT]!.balances[QUOTE]).toBe(400n);

  const closeSig = await signCloseOrder(MAKER_PK, 0, 2n);
  await h.execute({
    type: MutationType.CloseOrder,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 2n,
    deadline: FAR_DEADLINE,
    rawSignature: closeSig,
    mutation: { orderId: 0 },
  });
  expect(fresh.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(9000n + 600n);
  expect(fresh.accounts[MAKER_ACCOUNT]!.balances[BASE]).toBe(40n);

  await h.stop();
});
