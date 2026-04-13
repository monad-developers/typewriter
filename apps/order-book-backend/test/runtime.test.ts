import { expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { signTypedData } from "viem/accounts";
import { anvil } from "viem/chains";
import { EIP712_TYPES } from "../src/constants";
import { createState, MutationType } from "../src/exchange";
import { startRuntime } from "../src/runtime";
import { deployExchange, RPC_URL, SCHEDULER_ACCOUNT } from "./setup";

const MAKER_PK =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const TAKER_PK =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

const MAKER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TAKER: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const MAKER_ACCOUNT =
  `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
const TAKER_ACCOUNT =
  `0x000000000000000000000000${TAKER.slice(2).toLowerCase()}` as Hex;

const BASE: Address = "0x1111111111111111111111111111111111111111";
const QUOTE: Address = "0x2222222222222222222222222222222222222222";
const Q32 = 1n << 32n;
const FAR_DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 86400);

test("initialize creates account with root key and session key", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  const pubKey =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const mutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const sig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...mutation },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
    mutation,
  });

  const acc = state.accounts[MAKER_ACCOUNT]!;
  expect(acc.keys.length).toBe(2);
  expect(acc.keys[0]!.permissions).toBe(0xff);
  expect(acc.keys[1]!.permissions).toBe(0x7f);
  expect(acc.keys[1]!.keyType).toBe(2);
  await handle.stop();
});

test("initialize rejects already initialized account", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  const pubKey =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const mutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const sig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...mutation },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
    mutation,
  });

  const sig2 = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...mutation },
  });
  await expect(
    handle.execute({
      type: MutationType.Initialize,
      account: MAKER_ACCOUNT,
      keyId: 0,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature: sig2,
      mutation,
    }),
  ).rejects.toThrow("AlreadyInitialized");
  await handle.stop();
});

test("authorize adds a new key", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  const pubKey =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const initMutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const initSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...initMutation },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: initSig,
    mutation: initMutation,
  });

  const newPubKey =
    `0x000000000000000000000000${TAKER.slice(2).toLowerCase()}` as Hex;
  const authMutation = {
    expiry: 0,
    keyType: 2,
    permissions: 0x3f,
    publicKey: newPubKey,
  };
  const authSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Authorize",
    message: {
      account: MAKER_ACCOUNT,
      ...authMutation,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.Authorize,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: authSig,
    mutation: authMutation,
  });

  const acc = state.accounts[MAKER_ACCOUNT]!;
  expect(acc.keys.length).toBe(3);
  expect(acc.keys[2]!.permissions).toBe(0x3f);
  expect(acc.keys[2]!.publicKey).toBe(newPubKey);
  await handle.stop();
});

test("revoke removes a key", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  const pubKey =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const initMutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const initSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...initMutation },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: initSig,
    mutation: initMutation,
  });

  const revokeSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Revoke",
    message: {
      account: MAKER_ACCOUNT,
      keyId: 1n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.Revoke,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: revokeSig,
    mutation: { keyId: 1 },
  });

  expect(state.accounts[MAKER_ACCOUNT]!.keys[1]!.permissions).toBe(0);
  await handle.stop();
});

test("deposit credits balance", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  const pubKey =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const initMutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const initSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...initMutation },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: initSig,
    mutation: initMutation,
  });

  const depSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: {
      asset: QUOTE,
      amount: 10000n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.Deposit,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: depSig,
    mutation: { asset: QUOTE, amount: 10000n },
  });

  expect(state.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(10000n);
  await handle.stop();
});

test("withdrawal debits balance", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  const pubKey =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const initMutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const initSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...initMutation },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: initSig,
    mutation: initMutation,
  });

  const depSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: {
      asset: QUOTE,
      amount: 10000n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.Deposit,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: depSig,
    mutation: { asset: QUOTE, amount: 10000n },
  });

  const wSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Withdrawal",
    message: { asset: QUOTE, amount: 3000n, nonce: 1n, deadline: FAR_DEADLINE },
  });
  await handle.execute({
    type: MutationType.Withdrawal,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: wSig,
    mutation: { asset: QUOTE, amount: 3000n },
  });

  expect(state.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(7000n);
  await handle.stop();
});

test("withdrawal with insufficient balance rejects", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  const pubKey =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const initMutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const initSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...initMutation },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: initSig,
    mutation: initMutation,
  });

  const wSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Withdrawal",
    message: { asset: BASE, amount: 1n, nonce: 0n, deadline: FAR_DEADLINE },
  });
  await expect(
    handle.execute({
      type: MutationType.Withdrawal,
      account: MAKER_ACCOUNT,
      keyId: 1,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature: wSig,
      mutation: { asset: BASE, amount: 1n },
    }),
  ).rejects.toThrow("InsufficientBalance");
  await handle.stop();
});

test("add instrument creates instrument", async () => {
  const exchangeAddress = await deployExchange();
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  await handle.execute({
    type: MutationType.AddInstrument,
    mutation: {
      instrumentId: 0,
      base: BASE,
      quote: QUOTE,
      baseLotExp: 0,
      quoteLotExp: 0,
    },
  });

  expect(state.instruments[0]!.base).toBe(BASE);
  expect(state.instruments[0]!.quote).toBe(QUOTE);
  await handle.stop();
});

test("add duplicate instrument rejects", async () => {
  const exchangeAddress = await deployExchange();
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  await handle.execute({
    type: MutationType.AddInstrument,
    mutation: {
      instrumentId: 0,
      base: BASE,
      quote: QUOTE,
      baseLotExp: 0,
      quoteLotExp: 0,
    },
  });

  await expect(
    handle.execute({
      type: MutationType.AddInstrument,
      mutation: {
        instrumentId: 0,
        base: BASE,
        quote: QUOTE,
        baseLotExp: 0,
        quoteLotExp: 0,
      },
    }),
  ).rejects.toThrow("InstrumentAlreadyExists");
  await handle.stop();
});

test("limit order bid locks quote and places on book", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  await handle.execute({
    type: MutationType.AddInstrument,
    mutation: {
      instrumentId: 0,
      base: BASE,
      quote: QUOTE,
      baseLotExp: 0,
      quoteLotExp: 0,
    },
  });

  const pubKey =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const initMutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const initSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...initMutation },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: initSig,
    mutation: initMutation,
  });

  const depSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: {
      asset: QUOTE,
      amount: 10000n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.Deposit,
    account: MAKER_ACCOUNT,
    keyId: 1,
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
  const limitSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "LimitOrder",
    message: {
      quantity: order.quantity,
      instrumentId: BigInt(order.instrumentId),
      price: order.price,
      bidOrAsk: order.bidOrAsk,
      nonce: 1n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.LimitOrder,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: limitSig,
    mutation: order,
  });

  expect(state.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(9900n);
  const tick = state.instruments[0]!.bids[Number(10n * Q32)]!;
  expect(tick.quantity).toBe(10n);
  expect(tick.remainingQuantity).toBe(10n);
  expect(state.accounts[MAKER_ACCOUNT]!.orders[0]!.quantity).toBe(10n);
  await handle.stop();
});

test("limit order ask locks base and places on book", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  await handle.execute({
    type: MutationType.AddInstrument,
    mutation: {
      instrumentId: 0,
      base: BASE,
      quote: QUOTE,
      baseLotExp: 0,
      quoteLotExp: 0,
    },
  });

  const pubKey =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const initMutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const initSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...initMutation },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: initSig,
    mutation: initMutation,
  });

  const depSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: { asset: BASE, amount: 10000n, nonce: 0n, deadline: FAR_DEADLINE },
  });
  await handle.execute({
    type: MutationType.Deposit,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: depSig,
    mutation: { asset: BASE, amount: 10000n },
  });

  const order = {
    quantity: 10n,
    instrumentId: 0,
    price: 10n * Q32,
    bidOrAsk: 1 as const,
  };
  const limitSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "LimitOrder",
    message: {
      quantity: order.quantity,
      instrumentId: BigInt(order.instrumentId),
      price: order.price,
      bidOrAsk: order.bidOrAsk,
      nonce: 1n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.LimitOrder,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: limitSig,
    mutation: order,
  });

  expect(state.accounts[MAKER_ACCOUNT]!.balances[BASE]).toBe(9990n);
  const tick = state.instruments[0]!.asks[Number(10n * Q32)]!;
  expect(tick.quantity).toBe(10n);
  expect(tick.remainingQuantity).toBe(10n);
  await handle.stop();
});

test("limit order with insufficient balance rejects", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  await handle.execute({
    type: MutationType.AddInstrument,
    mutation: {
      instrumentId: 0,
      base: BASE,
      quote: QUOTE,
      baseLotExp: 0,
      quoteLotExp: 0,
    },
  });

  const pubKey =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const initMutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const initSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...initMutation },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: initSig,
    mutation: initMutation,
  });

  const order = {
    quantity: 10n,
    instrumentId: 0,
    price: 10n * Q32,
    bidOrAsk: 0 as const,
  };
  const limitSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "LimitOrder",
    message: {
      quantity: order.quantity,
      instrumentId: BigInt(order.instrumentId),
      price: order.price,
      bidOrAsk: order.bidOrAsk,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });
  await expect(
    handle.execute({
      type: MutationType.LimitOrder,
      account: MAKER_ACCOUNT,
      keyId: 1,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature: limitSig,
      mutation: order,
    }),
  ).rejects.toThrow("InsufficientBalance");
  await handle.stop();
});

test("market order sell fills against resting bid", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  await handle.execute({
    type: MutationType.AddInstrument,
    mutation: {
      instrumentId: 0,
      base: BASE,
      quote: QUOTE,
      baseLotExp: 0,
      quoteLotExp: 0,
    },
  });

  const makerPub =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const makerInit = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: makerPub,
    publicKey: makerPub,
  };
  const makerInitSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...makerInit },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: makerInitSig,
    mutation: makerInit,
  });

  const makerDepSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: {
      asset: QUOTE,
      amount: 10000n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.Deposit,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: makerDepSig,
    mutation: { asset: QUOTE, amount: 10000n },
  });

  const takerPub =
    `0x000000000000000000000000${TAKER.slice(2).toLowerCase()}` as Hex;
  const takerInit = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: takerPub,
    publicKey: takerPub,
  };
  const takerInitSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: TAKER_ACCOUNT, ...takerInit },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: TAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: takerInitSig,
    mutation: takerInit,
  });

  const takerDepSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: { asset: BASE, amount: 10000n, nonce: 0n, deadline: FAR_DEADLINE },
  });
  await handle.execute({
    type: MutationType.Deposit,
    account: TAKER_ACCOUNT,
    keyId: 1,
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
  const limitSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "LimitOrder",
    message: {
      quantity: limitOrder.quantity,
      instrumentId: BigInt(limitOrder.instrumentId),
      price: limitOrder.price,
      bidOrAsk: limitOrder.bidOrAsk,
      nonce: 1n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.LimitOrder,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: limitSig,
    mutation: limitOrder,
  });

  const marketOrder = {
    quantity: 10n,
    minReceivedQuantity: 0n,
    instrumentId: 0,
    bidOrAsk: 1 as const,
  };
  const marketSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "MarketOrder",
    message: {
      quantity: marketOrder.quantity,
      minReceivedQuantity: marketOrder.minReceivedQuantity,
      instrumentId: BigInt(marketOrder.instrumentId),
      bidOrAsk: marketOrder.bidOrAsk,
      nonce: 1n,
      deadline: FAR_DEADLINE,
    },
  });
  const result = await handle.execute({
    type: MutationType.MarketOrder,
    account: TAKER_ACCOUNT,
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: marketSig,
    mutation: marketOrder,
  });

  expect(state.accounts[TAKER_ACCOUNT]!.balances[BASE]).toBe(9990n);
  expect(state.accounts[TAKER_ACCOUNT]!.balances[QUOTE]).toBe(100n);
  expect(result.resolution.fills.length).toBe(1);
  expect(result.resolution.fills[0]!.quantity).toBe(10n);
  await handle.stop();
});

test("market order fills across multiple price levels", async () => {
  const exchangeAddress = await deployExchange();
  const domain = { name: "Exchange" as const, version: "1" as const, chainId: anvil.id, verifyingContract: exchangeAddress };
  const state = createState();
  const handle = startRuntime({ initialState: state, flushIntervalMs: 10, chain: anvil, rpcUrl: RPC_URL, account: SCHEDULER_ACCOUNT, address: exchangeAddress, rpId: "localhost", origin: "http://localhost:3000" });

  await handle.execute({ type: MutationType.AddInstrument, mutation: { instrumentId: 0, base: BASE, quote: QUOTE, baseLotExp: 0, quoteLotExp: 0 } });

  const makerPub = `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const makerInit = { expiry: 0, rootKeyType: 2, keyType: 2, permissions: 0x7f, rootPublicKey: makerPub, publicKey: makerPub };
  const makerInitSig = await signTypedData({ privateKey: MAKER_PK, domain, types: EIP712_TYPES, primaryType: "Initialize", message: { account: MAKER_ACCOUNT, ...makerInit } });
  await handle.execute({ type: MutationType.Initialize, account: MAKER_ACCOUNT, keyId: 0, nonce: 0n, deadline: FAR_DEADLINE, rawSignature: makerInitSig, mutation: makerInit });

  const makerDepSig = await signTypedData({ privateKey: MAKER_PK, domain, types: EIP712_TYPES, primaryType: "Deposit", message: { asset: QUOTE, amount: 100000n, nonce: 0n, deadline: FAR_DEADLINE } });
  await handle.execute({ type: MutationType.Deposit, account: MAKER_ACCOUNT, keyId: 1, nonce: 0n, deadline: FAR_DEADLINE, rawSignature: makerDepSig, mutation: { asset: QUOTE, amount: 100000n } });

  const limitOrder1 = { quantity: 5n, instrumentId: 0, price: 10n * Q32, bidOrAsk: 0 as const };
  const limitSig1 = await signTypedData({ privateKey: MAKER_PK, domain, types: EIP712_TYPES, primaryType: "LimitOrder", message: { quantity: limitOrder1.quantity, instrumentId: BigInt(limitOrder1.instrumentId), price: limitOrder1.price, bidOrAsk: limitOrder1.bidOrAsk, nonce: 1n, deadline: FAR_DEADLINE } });
  await handle.execute({ type: MutationType.LimitOrder, account: MAKER_ACCOUNT, keyId: 1, nonce: 1n, deadline: FAR_DEADLINE, rawSignature: limitSig1, mutation: limitOrder1 });

  const limitOrder2 = { quantity: 10n, instrumentId: 0, price: 8n * Q32, bidOrAsk: 0 as const };
  const limitSig2 = await signTypedData({ privateKey: MAKER_PK, domain, types: EIP712_TYPES, primaryType: "LimitOrder", message: { quantity: limitOrder2.quantity, instrumentId: BigInt(limitOrder2.instrumentId), price: limitOrder2.price, bidOrAsk: limitOrder2.bidOrAsk, nonce: 2n, deadline: FAR_DEADLINE } });
  await handle.execute({ type: MutationType.LimitOrder, account: MAKER_ACCOUNT, keyId: 1, nonce: 2n, deadline: FAR_DEADLINE, rawSignature: limitSig2, mutation: limitOrder2 });

  const takerPub = `0x000000000000000000000000${TAKER.slice(2).toLowerCase()}` as Hex;
  const takerInit = { expiry: 0, rootKeyType: 2, keyType: 2, permissions: 0x7f, rootPublicKey: takerPub, publicKey: takerPub };
  const takerInitSig = await signTypedData({ privateKey: TAKER_PK, domain, types: EIP712_TYPES, primaryType: "Initialize", message: { account: TAKER_ACCOUNT, ...takerInit } });
  await handle.execute({ type: MutationType.Initialize, account: TAKER_ACCOUNT, keyId: 0, nonce: 0n, deadline: FAR_DEADLINE, rawSignature: takerInitSig, mutation: takerInit });

  const takerDepSig = await signTypedData({ privateKey: TAKER_PK, domain, types: EIP712_TYPES, primaryType: "Deposit", message: { asset: BASE, amount: 10000n, nonce: 0n, deadline: FAR_DEADLINE } });
  await handle.execute({ type: MutationType.Deposit, account: TAKER_ACCOUNT, keyId: 1, nonce: 0n, deadline: FAR_DEADLINE, rawSignature: takerDepSig, mutation: { asset: BASE, amount: 10000n } });

  const marketOrder = { quantity: 12n, minReceivedQuantity: 0n, instrumentId: 0, bidOrAsk: 1 as const };
  const marketSig = await signTypedData({ privateKey: TAKER_PK, domain, types: EIP712_TYPES, primaryType: "MarketOrder", message: { quantity: marketOrder.quantity, minReceivedQuantity: marketOrder.minReceivedQuantity, instrumentId: BigInt(marketOrder.instrumentId), bidOrAsk: marketOrder.bidOrAsk, nonce: 1n, deadline: FAR_DEADLINE } });
  const result = await handle.execute({ type: MutationType.MarketOrder, account: TAKER_ACCOUNT, keyId: 1, nonce: 1n, deadline: FAR_DEADLINE, rawSignature: marketSig, mutation: marketOrder });

  expect(result.resolution.fills.length).toBe(2);
  expect(result.resolution.fills[0]!.price).toBe(10n * Q32);
  expect(result.resolution.fills[0]!.quantity).toBe(5n);
  expect(result.resolution.fills[1]!.price).toBe(8n * Q32);
  expect(result.resolution.fills[1]!.quantity).toBe(7n);
  expect(state.accounts[TAKER_ACCOUNT]!.balances[QUOTE]).toBe(5n * 10n + 7n * 8n);
  await handle.stop();
});

test("market order that exhausts a tick increments volume", async () => {
  const exchangeAddress = await deployExchange();
  const domain = { name: "Exchange" as const, version: "1" as const, chainId: anvil.id, verifyingContract: exchangeAddress };
  const state = createState();
  const handle = startRuntime({ initialState: state, flushIntervalMs: 10, chain: anvil, rpcUrl: RPC_URL, account: SCHEDULER_ACCOUNT, address: exchangeAddress, rpId: "localhost", origin: "http://localhost:3000" });

  await handle.execute({ type: MutationType.AddInstrument, mutation: { instrumentId: 0, base: BASE, quote: QUOTE, baseLotExp: 0, quoteLotExp: 0 } });

  const makerPub = `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const makerInit = { expiry: 0, rootKeyType: 2, keyType: 2, permissions: 0x7f, rootPublicKey: makerPub, publicKey: makerPub };
  const makerInitSig = await signTypedData({ privateKey: MAKER_PK, domain, types: EIP712_TYPES, primaryType: "Initialize", message: { account: MAKER_ACCOUNT, ...makerInit } });
  await handle.execute({ type: MutationType.Initialize, account: MAKER_ACCOUNT, keyId: 0, nonce: 0n, deadline: FAR_DEADLINE, rawSignature: makerInitSig, mutation: makerInit });

  const makerDepSig = await signTypedData({ privateKey: MAKER_PK, domain, types: EIP712_TYPES, primaryType: "Deposit", message: { asset: QUOTE, amount: 10000n, nonce: 0n, deadline: FAR_DEADLINE } });
  await handle.execute({ type: MutationType.Deposit, account: MAKER_ACCOUNT, keyId: 1, nonce: 0n, deadline: FAR_DEADLINE, rawSignature: makerDepSig, mutation: { asset: QUOTE, amount: 10000n } });

  const limitOrder = { quantity: 10n, instrumentId: 0, price: 10n * Q32, bidOrAsk: 0 as const };
  const limitSig = await signTypedData({ privateKey: MAKER_PK, domain, types: EIP712_TYPES, primaryType: "LimitOrder", message: { quantity: limitOrder.quantity, instrumentId: BigInt(limitOrder.instrumentId), price: limitOrder.price, bidOrAsk: limitOrder.bidOrAsk, nonce: 1n, deadline: FAR_DEADLINE } });
  await handle.execute({ type: MutationType.LimitOrder, account: MAKER_ACCOUNT, keyId: 1, nonce: 1n, deadline: FAR_DEADLINE, rawSignature: limitSig, mutation: limitOrder });

  const takerPub = `0x000000000000000000000000${TAKER.slice(2).toLowerCase()}` as Hex;
  const takerInit = { expiry: 0, rootKeyType: 2, keyType: 2, permissions: 0x7f, rootPublicKey: takerPub, publicKey: takerPub };
  const takerInitSig = await signTypedData({ privateKey: TAKER_PK, domain, types: EIP712_TYPES, primaryType: "Initialize", message: { account: TAKER_ACCOUNT, ...takerInit } });
  await handle.execute({ type: MutationType.Initialize, account: TAKER_ACCOUNT, keyId: 0, nonce: 0n, deadline: FAR_DEADLINE, rawSignature: takerInitSig, mutation: takerInit });

  const takerDepSig = await signTypedData({ privateKey: TAKER_PK, domain, types: EIP712_TYPES, primaryType: "Deposit", message: { asset: BASE, amount: 10000n, nonce: 0n, deadline: FAR_DEADLINE } });
  await handle.execute({ type: MutationType.Deposit, account: TAKER_ACCOUNT, keyId: 1, nonce: 0n, deadline: FAR_DEADLINE, rawSignature: takerDepSig, mutation: { asset: BASE, amount: 10000n } });

  const marketOrder = { quantity: 10n, minReceivedQuantity: 0n, instrumentId: 0, bidOrAsk: 1 as const };
  const marketSig = await signTypedData({ privateKey: TAKER_PK, domain, types: EIP712_TYPES, primaryType: "MarketOrder", message: { quantity: marketOrder.quantity, minReceivedQuantity: marketOrder.minReceivedQuantity, instrumentId: BigInt(marketOrder.instrumentId), bidOrAsk: marketOrder.bidOrAsk, nonce: 1n, deadline: FAR_DEADLINE } });
  await handle.execute({ type: MutationType.MarketOrder, account: TAKER_ACCOUNT, keyId: 1, nonce: 1n, deadline: FAR_DEADLINE, rawSignature: marketSig, mutation: marketOrder });

  const tick = state.instruments[0]!.bids[Number(10n * Q32)]!;
  expect(tick.quantity).toBe(0n);
  expect(tick.remainingQuantity).toBe(0n);
  expect(tick.volume).toBe(1);
  await handle.stop();
});

test("market order with insufficient taker balance rejects", async () => {
  const exchangeAddress = await deployExchange();
  const domain = { name: "Exchange" as const, version: "1" as const, chainId: anvil.id, verifyingContract: exchangeAddress };
  const state = createState();
  const handle = startRuntime({ initialState: state, flushIntervalMs: 10, chain: anvil, rpcUrl: RPC_URL, account: SCHEDULER_ACCOUNT, address: exchangeAddress, rpId: "localhost", origin: "http://localhost:3000" });

  await handle.execute({ type: MutationType.AddInstrument, mutation: { instrumentId: 0, base: BASE, quote: QUOTE, baseLotExp: 0, quoteLotExp: 0 } });

  const makerPub = `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const makerInit = { expiry: 0, rootKeyType: 2, keyType: 2, permissions: 0x7f, rootPublicKey: makerPub, publicKey: makerPub };
  const makerInitSig = await signTypedData({ privateKey: MAKER_PK, domain, types: EIP712_TYPES, primaryType: "Initialize", message: { account: MAKER_ACCOUNT, ...makerInit } });
  await handle.execute({ type: MutationType.Initialize, account: MAKER_ACCOUNT, keyId: 0, nonce: 0n, deadline: FAR_DEADLINE, rawSignature: makerInitSig, mutation: makerInit });

  const makerDepSig = await signTypedData({ privateKey: MAKER_PK, domain, types: EIP712_TYPES, primaryType: "Deposit", message: { asset: QUOTE, amount: 10000n, nonce: 0n, deadline: FAR_DEADLINE } });
  await handle.execute({ type: MutationType.Deposit, account: MAKER_ACCOUNT, keyId: 1, nonce: 0n, deadline: FAR_DEADLINE, rawSignature: makerDepSig, mutation: { asset: QUOTE, amount: 10000n } });

  const limitOrder = { quantity: 100n, instrumentId: 0, price: 10n * Q32, bidOrAsk: 0 as const };
  const limitSig = await signTypedData({ privateKey: MAKER_PK, domain, types: EIP712_TYPES, primaryType: "LimitOrder", message: { quantity: limitOrder.quantity, instrumentId: BigInt(limitOrder.instrumentId), price: limitOrder.price, bidOrAsk: limitOrder.bidOrAsk, nonce: 1n, deadline: FAR_DEADLINE } });
  await handle.execute({ type: MutationType.LimitOrder, account: MAKER_ACCOUNT, keyId: 1, nonce: 1n, deadline: FAR_DEADLINE, rawSignature: limitSig, mutation: limitOrder });

  const takerPub = `0x000000000000000000000000${TAKER.slice(2).toLowerCase()}` as Hex;
  const takerInit = { expiry: 0, rootKeyType: 2, keyType: 2, permissions: 0x7f, rootPublicKey: takerPub, publicKey: takerPub };
  const takerInitSig = await signTypedData({ privateKey: TAKER_PK, domain, types: EIP712_TYPES, primaryType: "Initialize", message: { account: TAKER_ACCOUNT, ...takerInit } });
  await handle.execute({ type: MutationType.Initialize, account: TAKER_ACCOUNT, keyId: 0, nonce: 0n, deadline: FAR_DEADLINE, rawSignature: takerInitSig, mutation: takerInit });

  const takerDepSig = await signTypedData({ privateKey: TAKER_PK, domain, types: EIP712_TYPES, primaryType: "Deposit", message: { asset: BASE, amount: 5n, nonce: 0n, deadline: FAR_DEADLINE } });
  await handle.execute({ type: MutationType.Deposit, account: TAKER_ACCOUNT, keyId: 1, nonce: 0n, deadline: FAR_DEADLINE, rawSignature: takerDepSig, mutation: { asset: BASE, amount: 5n } });

  const marketOrder = { quantity: 10n, minReceivedQuantity: 0n, instrumentId: 0, bidOrAsk: 1 as const };
  const marketSig = await signTypedData({ privateKey: TAKER_PK, domain, types: EIP712_TYPES, primaryType: "MarketOrder", message: { quantity: marketOrder.quantity, minReceivedQuantity: marketOrder.minReceivedQuantity, instrumentId: BigInt(marketOrder.instrumentId), bidOrAsk: marketOrder.bidOrAsk, nonce: 1n, deadline: FAR_DEADLINE } });
  await expect(
    handle.execute({ type: MutationType.MarketOrder, account: TAKER_ACCOUNT, keyId: 1, nonce: 1n, deadline: FAR_DEADLINE, rawSignature: marketSig, mutation: marketOrder }),
  ).rejects.toThrow("InsufficientBalance");
  await handle.stop();
});

test("market order buy fills against resting ask", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  await handle.execute({
    type: MutationType.AddInstrument,
    mutation: {
      instrumentId: 0,
      base: BASE,
      quote: QUOTE,
      baseLotExp: 0,
      quoteLotExp: 0,
    },
  });

  const makerPub =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const makerInit = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: makerPub,
    publicKey: makerPub,
  };
  const makerInitSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...makerInit },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: makerInitSig,
    mutation: makerInit,
  });

  const makerDepSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: { asset: BASE, amount: 10000n, nonce: 0n, deadline: FAR_DEADLINE },
  });
  await handle.execute({
    type: MutationType.Deposit,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: makerDepSig,
    mutation: { asset: BASE, amount: 10000n },
  });

  const takerPub =
    `0x000000000000000000000000${TAKER.slice(2).toLowerCase()}` as Hex;
  const takerInit = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: takerPub,
    publicKey: takerPub,
  };
  const takerInitSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: TAKER_ACCOUNT, ...takerInit },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: TAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: takerInitSig,
    mutation: takerInit,
  });

  const takerDepSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: {
      asset: QUOTE,
      amount: 10000n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.Deposit,
    account: TAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: takerDepSig,
    mutation: { asset: QUOTE, amount: 10000n },
  });

  const limitOrder = {
    quantity: 100n,
    instrumentId: 0,
    price: 10n * Q32,
    bidOrAsk: 1 as const,
  };
  const limitSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "LimitOrder",
    message: {
      quantity: limitOrder.quantity,
      instrumentId: BigInt(limitOrder.instrumentId),
      price: limitOrder.price,
      bidOrAsk: limitOrder.bidOrAsk,
      nonce: 1n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.LimitOrder,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: limitSig,
    mutation: limitOrder,
  });

  const marketOrder = {
    quantity: 10n,
    minReceivedQuantity: 0n,
    instrumentId: 0,
    bidOrAsk: 0 as const,
  };
  const marketSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "MarketOrder",
    message: {
      quantity: marketOrder.quantity,
      minReceivedQuantity: marketOrder.minReceivedQuantity,
      instrumentId: BigInt(marketOrder.instrumentId),
      bidOrAsk: marketOrder.bidOrAsk,
      nonce: 1n,
      deadline: FAR_DEADLINE,
    },
  });
  const result = await handle.execute({
    type: MutationType.MarketOrder,
    account: TAKER_ACCOUNT,
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: marketSig,
    mutation: marketOrder,
  });

  expect(state.accounts[TAKER_ACCOUNT]!.balances[QUOTE]).toBe(9900n);
  expect(state.accounts[TAKER_ACCOUNT]!.balances[BASE]).toBe(10n);
  expect(result.resolution.fills.length).toBe(1);
  await handle.stop();
});

test("market order with insufficient liquidity rejects", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  await handle.execute({
    type: MutationType.AddInstrument,
    mutation: {
      instrumentId: 0,
      base: BASE,
      quote: QUOTE,
      baseLotExp: 0,
      quoteLotExp: 0,
    },
  });

  const takerPub =
    `0x000000000000000000000000${TAKER.slice(2).toLowerCase()}` as Hex;
  const takerInit = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: takerPub,
    publicKey: takerPub,
  };
  const takerInitSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: TAKER_ACCOUNT, ...takerInit },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: TAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: takerInitSig,
    mutation: takerInit,
  });

  const takerDepSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: { asset: BASE, amount: 10000n, nonce: 0n, deadline: FAR_DEADLINE },
  });
  await handle.execute({
    type: MutationType.Deposit,
    account: TAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: takerDepSig,
    mutation: { asset: BASE, amount: 10000n },
  });

  const marketOrder = {
    quantity: 10n,
    minReceivedQuantity: 0n,
    instrumentId: 0,
    bidOrAsk: 1 as const,
  };
  const marketSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "MarketOrder",
    message: {
      quantity: marketOrder.quantity,
      minReceivedQuantity: marketOrder.minReceivedQuantity,
      instrumentId: BigInt(marketOrder.instrumentId),
      bidOrAsk: marketOrder.bidOrAsk,
      nonce: 1n,
      deadline: FAR_DEADLINE,
    },
  });
  await expect(
    handle.execute({
      type: MutationType.MarketOrder,
      account: TAKER_ACCOUNT,
      keyId: 1,
      nonce: 1n,
      deadline: FAR_DEADLINE,
      rawSignature: marketSig,
      mutation: marketOrder,
    }),
  ).rejects.toThrow("InsufficientLiquidity");
  await handle.stop();
});

test("market order with slippage exceeded rejects", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  await handle.execute({
    type: MutationType.AddInstrument,
    mutation: {
      instrumentId: 0,
      base: BASE,
      quote: QUOTE,
      baseLotExp: 0,
      quoteLotExp: 0,
    },
  });

  const makerPub =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const makerInit = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: makerPub,
    publicKey: makerPub,
  };
  const makerInitSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...makerInit },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: makerInitSig,
    mutation: makerInit,
  });

  const makerDepSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: {
      asset: QUOTE,
      amount: 10000n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.Deposit,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: makerDepSig,
    mutation: { asset: QUOTE, amount: 10000n },
  });

  const takerPub =
    `0x000000000000000000000000${TAKER.slice(2).toLowerCase()}` as Hex;
  const takerInit = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: takerPub,
    publicKey: takerPub,
  };
  const takerInitSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: TAKER_ACCOUNT, ...takerInit },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: TAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: takerInitSig,
    mutation: takerInit,
  });

  const takerDepSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: { asset: BASE, amount: 10000n, nonce: 0n, deadline: FAR_DEADLINE },
  });
  await handle.execute({
    type: MutationType.Deposit,
    account: TAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: takerDepSig,
    mutation: { asset: BASE, amount: 10000n },
  });

  const limitOrder = {
    quantity: 100n,
    instrumentId: 0,
    price: 1n * Q32,
    bidOrAsk: 0 as const,
  };
  const limitSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "LimitOrder",
    message: {
      quantity: limitOrder.quantity,
      instrumentId: BigInt(limitOrder.instrumentId),
      price: limitOrder.price,
      bidOrAsk: limitOrder.bidOrAsk,
      nonce: 1n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.LimitOrder,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: limitSig,
    mutation: limitOrder,
  });

  const marketOrder = {
    quantity: 10n,
    minReceivedQuantity: 200n,
    instrumentId: 0,
    bidOrAsk: 1 as const,
  };
  const marketSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "MarketOrder",
    message: {
      quantity: marketOrder.quantity,
      minReceivedQuantity: marketOrder.minReceivedQuantity,
      instrumentId: BigInt(marketOrder.instrumentId),
      bidOrAsk: marketOrder.bidOrAsk,
      nonce: 1n,
      deadline: FAR_DEADLINE,
    },
  });
  await expect(
    handle.execute({
      type: MutationType.MarketOrder,
      account: TAKER_ACCOUNT,
      keyId: 1,
      nonce: 1n,
      deadline: FAR_DEADLINE,
      rawSignature: marketSig,
      mutation: marketOrder,
    }),
  ).rejects.toThrow("SlippageExceeded");
  await handle.stop();
});

test("close order refunds unfilled and credits filled", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  await handle.execute({
    type: MutationType.AddInstrument,
    mutation: {
      instrumentId: 0,
      base: BASE,
      quote: QUOTE,
      baseLotExp: 0,
      quoteLotExp: 0,
    },
  });

  const makerPub =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const makerInit = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: makerPub,
    publicKey: makerPub,
  };
  const makerInitSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...makerInit },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: makerInitSig,
    mutation: makerInit,
  });

  const makerDepSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: {
      asset: QUOTE,
      amount: 10000n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.Deposit,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: makerDepSig,
    mutation: { asset: QUOTE, amount: 10000n },
  });

  const takerPub =
    `0x000000000000000000000000${TAKER.slice(2).toLowerCase()}` as Hex;
  const takerInit = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: takerPub,
    publicKey: takerPub,
  };
  const takerInitSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: TAKER_ACCOUNT, ...takerInit },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: TAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: takerInitSig,
    mutation: takerInit,
  });

  const takerDepSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: { asset: BASE, amount: 10000n, nonce: 0n, deadline: FAR_DEADLINE },
  });
  await handle.execute({
    type: MutationType.Deposit,
    account: TAKER_ACCOUNT,
    keyId: 1,
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
  const limitSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "LimitOrder",
    message: {
      quantity: limitOrder.quantity,
      instrumentId: BigInt(limitOrder.instrumentId),
      price: limitOrder.price,
      bidOrAsk: limitOrder.bidOrAsk,
      nonce: 1n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.LimitOrder,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: limitSig,
    mutation: limitOrder,
  });

  const marketOrder = {
    quantity: 40n,
    minReceivedQuantity: 0n,
    instrumentId: 0,
    bidOrAsk: 1 as const,
  };
  const marketSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "MarketOrder",
    message: {
      quantity: marketOrder.quantity,
      minReceivedQuantity: marketOrder.minReceivedQuantity,
      instrumentId: BigInt(marketOrder.instrumentId),
      bidOrAsk: marketOrder.bidOrAsk,
      nonce: 1n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.MarketOrder,
    account: TAKER_ACCOUNT,
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: marketSig,
    mutation: marketOrder,
  });

  const closeSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "CloseOrder",
    message: { orderId: 0n, nonce: 2n, deadline: FAR_DEADLINE },
  });
  await handle.execute({
    type: MutationType.CloseOrder,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 2n,
    deadline: FAR_DEADLINE,
    rawSignature: closeSig,
    mutation: { orderId: 0 },
  });

  expect(state.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(9000n + 600n);
  expect(state.accounts[MAKER_ACCOUNT]!.balances[BASE]).toBe(40n);
  await handle.stop();
});

test("close nonexistent order rejects", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  await handle.execute({
    type: MutationType.AddInstrument,
    mutation: {
      instrumentId: 0,
      base: BASE,
      quote: QUOTE,
      baseLotExp: 0,
      quoteLotExp: 0,
    },
  });

  const pubKey =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const initMutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const initSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...initMutation },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: initSig,
    mutation: initMutation,
  });

  const closeSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "CloseOrder",
    message: { orderId: 0n, nonce: 0n, deadline: FAR_DEADLINE },
  });
  await expect(
    handle.execute({
      type: MutationType.CloseOrder,
      account: MAKER_ACCOUNT,
      keyId: 1,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature: closeSig,
      mutation: { orderId: 0 },
    }),
  ).rejects.toThrow("OrderNotFound");
  await handle.stop();
});

test("invalid signature rejects", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  const pubKey =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const initMutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const initSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...initMutation },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: initSig,
    mutation: initMutation,
  });

  const wrongSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: { asset: QUOTE, amount: 500n, nonce: 0n, deadline: FAR_DEADLINE },
  });
  await expect(
    handle.execute({
      type: MutationType.Deposit,
      account: MAKER_ACCOUNT,
      keyId: 1,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature: wrongSig,
      mutation: { asset: QUOTE, amount: 500n },
    }),
  ).rejects.toThrow("InvalidSignature");
  await handle.stop();
});

test("expired deadline rejects", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  const pubKey =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const initMutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const initSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...initMutation },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: initSig,
    mutation: initMutation,
  });

  const expired = BigInt(Math.floor(Date.now() / 1000) - 1);
  const depSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: { asset: QUOTE, amount: 500n, nonce: 0n, deadline: FAR_DEADLINE },
  });
  await expect(
    handle.execute({
      type: MutationType.Deposit,
      account: MAKER_ACCOUNT,
      keyId: 1,
      nonce: 0n,
      deadline: expired,
      rawSignature: depSig,
      mutation: { asset: QUOTE, amount: 500n },
    }),
  ).rejects.toThrow("SignatureExpired");
  await handle.stop();
});

test("wrong nonce rejects", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  const pubKey =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const initMutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const initSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...initMutation },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: initSig,
    mutation: initMutation,
  });

  const depSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: { asset: QUOTE, amount: 500n, nonce: 99n, deadline: FAR_DEADLINE },
  });
  await expect(
    handle.execute({
      type: MutationType.Deposit,
      account: MAKER_ACCOUNT,
      keyId: 1,
      nonce: 99n,
      deadline: FAR_DEADLINE,
      rawSignature: depSig,
      mutation: { asset: QUOTE, amount: 500n },
    }),
  ).rejects.toThrow("InvalidNonce");
  await handle.stop();
});

test("full lifecycle: deposit, limit, market, close", async () => {
  const exchangeAddress = await deployExchange();
  const domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
  const state = createState();
  const handle = startRuntime({
    initialState: state,
    flushIntervalMs: 10,
    chain: anvil,
    rpcUrl: RPC_URL,
    account: SCHEDULER_ACCOUNT,
    address: exchangeAddress,
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  await handle.execute({
    type: MutationType.AddInstrument,
    mutation: {
      instrumentId: 0,
      base: BASE,
      quote: QUOTE,
      baseLotExp: 0,
      quoteLotExp: 0,
    },
  });

  const makerPub =
    `0x000000000000000000000000${MAKER.slice(2).toLowerCase()}` as Hex;
  const makerInit = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: makerPub,
    publicKey: makerPub,
  };
  const makerInitSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: MAKER_ACCOUNT, ...makerInit },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: MAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: makerInitSig,
    mutation: makerInit,
  });

  const makerDepSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: {
      asset: QUOTE,
      amount: 10000n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.Deposit,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: makerDepSig,
    mutation: { asset: QUOTE, amount: 10000n },
  });

  const takerPub =
    `0x000000000000000000000000${TAKER.slice(2).toLowerCase()}` as Hex;
  const takerInit = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: takerPub,
    publicKey: takerPub,
  };
  const takerInitSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account: TAKER_ACCOUNT, ...takerInit },
  });
  await handle.execute({
    type: MutationType.Initialize,
    account: TAKER_ACCOUNT,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: takerInitSig,
    mutation: takerInit,
  });

  const takerDepSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: { asset: BASE, amount: 10000n, nonce: 0n, deadline: FAR_DEADLINE },
  });
  await handle.execute({
    type: MutationType.Deposit,
    account: TAKER_ACCOUNT,
    keyId: 1,
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
  const limitSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "LimitOrder",
    message: {
      quantity: limitOrder.quantity,
      instrumentId: BigInt(limitOrder.instrumentId),
      price: limitOrder.price,
      bidOrAsk: limitOrder.bidOrAsk,
      nonce: 1n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.LimitOrder,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: limitSig,
    mutation: limitOrder,
  });
  expect(state.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(9000n);

  const marketOrder = {
    quantity: 40n,
    minReceivedQuantity: 0n,
    instrumentId: 0,
    bidOrAsk: 1 as const,
  };
  const marketSig = await signTypedData({
    privateKey: TAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "MarketOrder",
    message: {
      quantity: marketOrder.quantity,
      minReceivedQuantity: marketOrder.minReceivedQuantity,
      instrumentId: BigInt(marketOrder.instrumentId),
      bidOrAsk: marketOrder.bidOrAsk,
      nonce: 1n,
      deadline: FAR_DEADLINE,
    },
  });
  await handle.execute({
    type: MutationType.MarketOrder,
    account: TAKER_ACCOUNT,
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: marketSig,
    mutation: marketOrder,
  });
  expect(state.accounts[TAKER_ACCOUNT]!.balances[BASE]).toBe(9960n);
  expect(state.accounts[TAKER_ACCOUNT]!.balances[QUOTE]).toBe(400n);

  const closeSig = await signTypedData({
    privateKey: MAKER_PK,
    domain,
    types: EIP712_TYPES,
    primaryType: "CloseOrder",
    message: { orderId: 0n, nonce: 2n, deadline: FAR_DEADLINE },
  });
  await handle.execute({
    type: MutationType.CloseOrder,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 2n,
    deadline: FAR_DEADLINE,
    rawSignature: closeSig,
    mutation: { orderId: 0 },
  });
  expect(state.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(9000n + 600n);
  expect(state.accounts[MAKER_ACCOUNT]!.balances[BASE]).toBe(40n);
  await handle.stop();
});
