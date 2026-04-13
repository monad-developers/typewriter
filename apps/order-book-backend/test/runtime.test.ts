import { expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { signTypedData } from "viem/accounts";
import { anvil } from "viem/chains";
import { EIP712_TYPES } from "../src/constants";
import { MutationType } from "../src/exchange";
import { exchangeAddress, handle, state } from "./setup";

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

function padAddress(addr: Address): Hex {
  return `0x000000000000000000000000${addr.slice(2).toLowerCase()}` as Hex;
}

function domain() {
  return {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: anvil.id,
    verifyingContract: exchangeAddress,
  };
}

async function signInitialize(
  pk: Hex,
  account: Hex,
  mutation: {
    expiry: number;
    rootKeyType: number;
    keyType: number;
    permissions: number;
    rootPublicKey: Hex;
    publicKey: Hex;
  },
): Promise<Hex> {
  return signTypedData({
    privateKey: pk,
    domain: domain(),
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: {
      account,
      expiry: mutation.expiry,
      rootKeyType: mutation.rootKeyType,
      keyType: mutation.keyType,
      permissions: mutation.permissions,
      rootPublicKey: mutation.rootPublicKey,
      publicKey: mutation.publicKey,
    },
  });
}

async function signAuthorize(
  pk: Hex,
  account: Hex,
  mutation: {
    expiry: number;
    keyType: number;
    permissions: number;
    publicKey: Hex;
  },
  nonce: bigint,
): Promise<Hex> {
  return signTypedData({
    privateKey: pk,
    domain: domain(),
    types: EIP712_TYPES,
    primaryType: "Authorize",
    message: {
      account,
      expiry: mutation.expiry,
      keyType: mutation.keyType,
      permissions: mutation.permissions,
      publicKey: mutation.publicKey,
      nonce,
      deadline: FAR_DEADLINE,
    },
  });
}

async function signRevoke(
  pk: Hex,
  account: Hex,
  keyId: number,
  nonce: bigint,
): Promise<Hex> {
  return signTypedData({
    privateKey: pk,
    domain: domain(),
    types: EIP712_TYPES,
    primaryType: "Revoke",
    message: {
      account,
      keyId: BigInt(keyId),
      nonce,
      deadline: FAR_DEADLINE,
    },
  });
}

async function signDeposit(
  pk: Hex,
  asset: Address,
  amount: bigint,
  nonce: bigint,
): Promise<Hex> {
  return signTypedData({
    privateKey: pk,
    domain: domain(),
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: { asset, amount, nonce, deadline: FAR_DEADLINE },
  });
}

async function signWithdrawal(
  pk: Hex,
  asset: Address,
  amount: bigint,
  nonce: bigint,
): Promise<Hex> {
  return signTypedData({
    privateKey: pk,
    domain: domain(),
    types: EIP712_TYPES,
    primaryType: "Withdrawal",
    message: { asset, amount, nonce, deadline: FAR_DEADLINE },
  });
}

async function signLimitOrder(
  pk: Hex,
  order: { quantity: bigint; instrumentId: number; price: bigint; bidOrAsk: 0 | 1 },
  nonce: bigint,
): Promise<Hex> {
  return signTypedData({
    privateKey: pk,
    domain: domain(),
    types: EIP712_TYPES,
    primaryType: "LimitOrder",
    message: {
      quantity: order.quantity,
      instrumentId: BigInt(order.instrumentId),
      price: order.price,
      bidOrAsk: order.bidOrAsk,
      nonce,
      deadline: FAR_DEADLINE,
    },
  });
}

async function signMarketOrder(
  pk: Hex,
  order: {
    quantity: bigint;
    minReceivedQuantity: bigint;
    instrumentId: number;
    bidOrAsk: 0 | 1;
  },
  nonce: bigint,
): Promise<Hex> {
  return signTypedData({
    privateKey: pk,
    domain: domain(),
    types: EIP712_TYPES,
    primaryType: "MarketOrder",
    message: {
      quantity: order.quantity,
      minReceivedQuantity: order.minReceivedQuantity,
      instrumentId: BigInt(order.instrumentId),
      bidOrAsk: order.bidOrAsk,
      nonce,
      deadline: FAR_DEADLINE,
    },
  });
}

async function signCloseOrder(
  pk: Hex,
  orderId: number,
  nonce: bigint,
): Promise<Hex> {
  return signTypedData({
    privateKey: pk,
    domain: domain(),
    types: EIP712_TYPES,
    primaryType: "CloseOrder",
    message: { orderId: BigInt(orderId), nonce, deadline: FAR_DEADLINE },
  });
}

async function initializeAccount(
  pk: Hex,
  account: Hex,
  permissions = 0x7f,
): Promise<void> {
  const addr = pk === MAKER_PK ? MAKER : TAKER;
  const pubKey = padAddress(addr);
  const mutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const sig = await signInitialize(pk, account, mutation);
  await handle.execute({
    type: MutationType.Initialize,
    account,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
    mutation,
  });
}

async function initAndDeposit(
  pk: Hex,
  account: Hex,
  asset: Address,
  amount: bigint,
): Promise<void> {
  await initializeAccount(pk, account);
  const sig = await signDeposit(pk, asset, amount, 0n);
  await handle.execute({
    type: MutationType.Deposit,
    account,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
    mutation: { asset, amount },
  });
}

async function addInstrument(): Promise<void> {
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
}

test("initialize creates account with root key and session key", async () => {
  const pubKey = padAddress(MAKER);
  const mutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const sig = await signInitialize(MAKER_PK, MAKER_ACCOUNT, mutation);
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
});

test("initialize rejects already initialized account", async () => {
  await initializeAccount(MAKER_PK, MAKER_ACCOUNT);

  const pubKey = padAddress(MAKER);
  const mutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const sig = await signInitialize(MAKER_PK, MAKER_ACCOUNT, mutation);
  await expect(
    handle.execute({
      type: MutationType.Initialize,
      account: MAKER_ACCOUNT,
      keyId: 0,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature: sig,
      mutation,
    }),
  ).rejects.toThrow("AlreadyInitialized");
});

test("authorize adds a new key", async () => {
  await initializeAccount(MAKER_PK, MAKER_ACCOUNT);

  const newPubKey = padAddress(TAKER);
  const mutation = {
    expiry: 0,
    keyType: 2,
    permissions: 0x3f,
    publicKey: newPubKey,
  };
  const sig = await signAuthorize(MAKER_PK, MAKER_ACCOUNT, mutation, 0n);
  await handle.execute({
    type: MutationType.Authorize,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
    mutation,
  });

  const acc = state.accounts[MAKER_ACCOUNT]!;
  expect(acc.keys.length).toBe(3);
  expect(acc.keys[2]!.permissions).toBe(0x3f);
  expect(acc.keys[2]!.publicKey).toBe(newPubKey);
});

test("revoke removes a key", async () => {
  await initializeAccount(MAKER_PK, MAKER_ACCOUNT);

  const sig = await signRevoke(MAKER_PK, MAKER_ACCOUNT, 1, 0n);
  await handle.execute({
    type: MutationType.Revoke,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
    mutation: { keyId: 1 },
  });

  const acc = state.accounts[MAKER_ACCOUNT]!;
  expect(acc.keys[1]!.permissions).toBe(0);
});

test("deposit credits balance", async () => {
  await initializeAccount(MAKER_PK, MAKER_ACCOUNT);

  const sig = await signDeposit(MAKER_PK, QUOTE, 10000n, 0n);
  await handle.execute({
    type: MutationType.Deposit,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
    mutation: { asset: QUOTE, amount: 10000n },
  });

  expect(state.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(10000n);
});

test("withdrawal debits balance", async () => {
  await initAndDeposit(MAKER_PK, MAKER_ACCOUNT, QUOTE, 10000n);

  const sig = await signWithdrawal(MAKER_PK, QUOTE, 3000n, 1n);
  await handle.execute({
    type: MutationType.Withdrawal,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
    mutation: { asset: QUOTE, amount: 3000n },
  });

  expect(state.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(7000n);
});

test("withdrawal with insufficient balance rejects", async () => {
  await initializeAccount(MAKER_PK, MAKER_ACCOUNT);

  const sig = await signWithdrawal(MAKER_PK, BASE, 1n, 0n);
  await expect(
    handle.execute({
      type: MutationType.Withdrawal,
      account: MAKER_ACCOUNT,
      keyId: 1,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature: sig,
      mutation: { asset: BASE, amount: 1n },
    }),
  ).rejects.toThrow("InsufficientBalance");
});

test("add instrument creates instrument", async () => {
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

  const inst = state.instruments[0]!;
  expect(inst.base).toBe(BASE);
  expect(inst.quote).toBe(QUOTE);
});

test("add duplicate instrument rejects", async () => {
  await addInstrument();

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
});

test("limit order bid locks quote and places on book", async () => {
  await addInstrument();
  await initAndDeposit(MAKER_PK, MAKER_ACCOUNT, QUOTE, 10000n);

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
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
    mutation: order,
  });

  expect(state.accounts[MAKER_ACCOUNT]!.balances[QUOTE]).toBe(9900n);
  const tick = state.instruments[0]!.bids[Number(10n * Q32)]!;
  expect(tick.quantity).toBe(10n);
  expect(tick.remainingQuantity).toBe(10n);
  expect(state.accounts[MAKER_ACCOUNT]!.orders[0]!.quantity).toBe(10n);
});

test("limit order ask locks base and places on book", async () => {
  await addInstrument();
  await initAndDeposit(MAKER_PK, MAKER_ACCOUNT, BASE, 10000n);

  const order = {
    quantity: 10n,
    instrumentId: 0,
    price: 10n * Q32,
    bidOrAsk: 1 as const,
  };
  const sig = await signLimitOrder(MAKER_PK, order, 1n);
  await handle.execute({
    type: MutationType.LimitOrder,
    account: MAKER_ACCOUNT,
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
    mutation: order,
  });

  expect(state.accounts[MAKER_ACCOUNT]!.balances[BASE]).toBe(9990n);
  const tick = state.instruments[0]!.asks[Number(10n * Q32)]!;
  expect(tick.quantity).toBe(10n);
  expect(tick.remainingQuantity).toBe(10n);
});

test("limit order with insufficient balance rejects", async () => {
  await addInstrument();
  await initializeAccount(MAKER_PK, MAKER_ACCOUNT);

  const order = {
    quantity: 10n,
    instrumentId: 0,
    price: 10n * Q32,
    bidOrAsk: 0 as const,
  };
  const sig = await signLimitOrder(MAKER_PK, order, 0n);
  await expect(
    handle.execute({
      type: MutationType.LimitOrder,
      account: MAKER_ACCOUNT,
      keyId: 1,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature: sig,
      mutation: order,
    }),
  ).rejects.toThrow("InsufficientBalance");
});

test("market order sell fills against resting bid", async () => {
  await addInstrument();
  await initAndDeposit(MAKER_PK, MAKER_ACCOUNT, QUOTE, 10000n);
  await initAndDeposit(TAKER_PK, TAKER_ACCOUNT, BASE, 10000n);

  const limitOrder = {
    quantity: 100n,
    instrumentId: 0,
    price: 10n * Q32,
    bidOrAsk: 0 as const,
  };
  const limitSig = await signLimitOrder(MAKER_PK, limitOrder, 1n);
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
  const marketSig = await signMarketOrder(TAKER_PK, marketOrder, 1n);
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
});

test("market order buy fills against resting ask", async () => {
  await addInstrument();
  await initAndDeposit(MAKER_PK, MAKER_ACCOUNT, BASE, 10000n);
  await initAndDeposit(TAKER_PK, TAKER_ACCOUNT, QUOTE, 10000n);

  const limitOrder = {
    quantity: 100n,
    instrumentId: 0,
    price: 10n * Q32,
    bidOrAsk: 1 as const,
  };
  const limitSig = await signLimitOrder(MAKER_PK, limitOrder, 1n);
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
  const marketSig = await signMarketOrder(TAKER_PK, marketOrder, 1n);
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
});

test("market order with insufficient liquidity rejects", async () => {
  await addInstrument();
  await initAndDeposit(TAKER_PK, TAKER_ACCOUNT, BASE, 10000n);

  const marketOrder = {
    quantity: 10n,
    minReceivedQuantity: 0n,
    instrumentId: 0,
    bidOrAsk: 1 as const,
  };
  const marketSig = await signMarketOrder(TAKER_PK, marketOrder, 1n);
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
});

test("market order with slippage exceeded rejects", async () => {
  await addInstrument();
  await initAndDeposit(MAKER_PK, MAKER_ACCOUNT, QUOTE, 10000n);
  await initAndDeposit(TAKER_PK, TAKER_ACCOUNT, BASE, 10000n);

  const limitOrder = {
    quantity: 100n,
    instrumentId: 0,
    price: 1n * Q32,
    bidOrAsk: 0 as const,
  };
  const limitSig = await signLimitOrder(MAKER_PK, limitOrder, 1n);
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
  const marketSig = await signMarketOrder(TAKER_PK, marketOrder, 1n);
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
});

test("close order refunds unfilled and credits filled", async () => {
  await addInstrument();
  await initAndDeposit(MAKER_PK, MAKER_ACCOUNT, QUOTE, 10000n);
  await initAndDeposit(TAKER_PK, TAKER_ACCOUNT, BASE, 10000n);

  const limitOrder = {
    quantity: 100n,
    instrumentId: 0,
    price: 10n * Q32,
    bidOrAsk: 0 as const,
  };
  const limitSig = await signLimitOrder(MAKER_PK, limitOrder, 1n);
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
  const marketSig = await signMarketOrder(TAKER_PK, marketOrder, 1n);
  await handle.execute({
    type: MutationType.MarketOrder,
    account: TAKER_ACCOUNT,
    keyId: 1,
    nonce: 1n,
    deadline: FAR_DEADLINE,
    rawSignature: marketSig,
    mutation: marketOrder,
  });

  const closeSig = await signCloseOrder(MAKER_PK, 0, 2n);
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
});

test("close nonexistent order rejects", async () => {
  await addInstrument();
  await initializeAccount(MAKER_PK, MAKER_ACCOUNT);

  const sig = await signCloseOrder(MAKER_PK, 0, 0n);
  await expect(
    handle.execute({
      type: MutationType.CloseOrder,
      account: MAKER_ACCOUNT,
      keyId: 1,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature: sig,
      mutation: { orderId: 0 },
    }),
  ).rejects.toThrow("OrderNotFound");
});

test("invalid signature rejects", async () => {
  await initializeAccount(MAKER_PK, MAKER_ACCOUNT);

  const sig = await signDeposit(TAKER_PK, QUOTE, 500n, 0n);
  await expect(
    handle.execute({
      type: MutationType.Deposit,
      account: MAKER_ACCOUNT,
      keyId: 1,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature: sig,
      mutation: { asset: QUOTE, amount: 500n },
    }),
  ).rejects.toThrow("InvalidSignature");
});

test("expired deadline rejects", async () => {
  await initializeAccount(MAKER_PK, MAKER_ACCOUNT);

  const expired = BigInt(Math.floor(Date.now() / 1000) - 1);
  const sig = await signDeposit(MAKER_PK, QUOTE, 500n, 0n);
  await expect(
    handle.execute({
      type: MutationType.Deposit,
      account: MAKER_ACCOUNT,
      keyId: 1,
      nonce: 0n,
      deadline: expired,
      rawSignature: sig,
      mutation: { asset: QUOTE, amount: 500n },
    }),
  ).rejects.toThrow("SignatureExpired");
});

test("wrong nonce rejects", async () => {
  await initializeAccount(MAKER_PK, MAKER_ACCOUNT);

  const sig = await signDeposit(MAKER_PK, QUOTE, 500n, 99n);
  await expect(
    handle.execute({
      type: MutationType.Deposit,
      account: MAKER_ACCOUNT,
      keyId: 1,
      nonce: 99n,
      deadline: FAR_DEADLINE,
      rawSignature: sig,
      mutation: { asset: QUOTE, amount: 500n },
    }),
  ).rejects.toThrow("InvalidNonce");
});

test("full lifecycle: deposit, limit, market, close", async () => {
  await addInstrument();
  await initAndDeposit(MAKER_PK, MAKER_ACCOUNT, QUOTE, 10000n);
  await initAndDeposit(TAKER_PK, TAKER_ACCOUNT, BASE, 10000n);

  const limitOrder = {
    quantity: 100n,
    instrumentId: 0,
    price: 10n * Q32,
    bidOrAsk: 0 as const,
  };
  const limitSig = await signLimitOrder(MAKER_PK, limitOrder, 1n);
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
  const marketSig = await signMarketOrder(TAKER_PK, marketOrder, 1n);
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

  const closeSig = await signCloseOrder(MAKER_PK, 0, 2n);
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
});
