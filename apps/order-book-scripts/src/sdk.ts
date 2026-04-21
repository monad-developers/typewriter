import type { State } from "order-book-backend/src/exchange";
import { EIP712_TYPES } from "order-book-sdk";
import * as Address from "ox/Address";
import type * as Hex from "ox/Hex";
import * as Secp256k1 from "ox/Secp256k1";
import * as Signature from "ox/Signature";
import * as TypedData from "ox/TypedData";
import { API_URL, CHAIN_ID, EXCHANGE_ADDRESS } from "./constants";

console.log(
  `Using API_URL=${API_URL}, CHAIN_ID=${CHAIN_ID}, EXCHANGE_ADDRESS=${EXCHANGE_ADDRESS}`,
);

const FAR_DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 86400);

function domain() {
  return {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: CHAIN_ID,
    verifyingContract: EXCHANGE_ADDRESS,
  };
}

export function sign(
  privateKey: Hex.Hex,
  primaryType: string,
  message: Record<string, unknown>,
): Hex.Hex {
  const payload = TypedData.getSignPayload({
    domain: domain(),
    types: EIP712_TYPES,
    primaryType: primaryType as keyof typeof EIP712_TYPES,
    message: message as never,
  });
  const sig = Secp256k1.sign({ payload, privateKey });
  return Signature.toHex(sig);
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path} failed: ${data.error}`);
  return data;
}

import {
  type InstrumentConfig,
  priceToQ32,
  type TokenAmount,
} from "order-book-sdk";

export type Account = {
  privateKey: Hex.Hex;
  address: Address.Address;
  accountHex: Hex.Hex;
  keyId: number;
  nonceKey: bigint;
  seq: bigint;
};

type MutationOpts = { concurrent?: boolean };

function randomNonceKey(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let key = 0n;
  for (const b of bytes) key = (key << 8n) | BigInt(b);
  return key;
}

function reserveNonce(
  account: Account,
  opts?: MutationOpts,
): { nonce: bigint; rollback: () => void } {
  if (opts?.concurrent) {
    return { nonce: randomNonceKey() << 64n, rollback: () => {} };
  }
  const nonce = (account.nonceKey << 64n) | account.seq;
  account.seq++;
  return {
    nonce,
    rollback: () => {
      account.seq--;
    },
  };
}

async function postWithNonce<T>(
  rollback: () => void,
  path: string,
  body: unknown,
): Promise<T> {
  try {
    return (await post(path, body)) as T;
  } catch (err) {
    rollback();
    throw err;
  }
}

/** Round down to the nearest lot multiple. The contract rejects non-multiples. */
function lotAligned(raw: bigint, lotExp: number): bigint {
  const e = BigInt(lotExp);
  return (raw >> e) << e;
}

export async function createAccount(privateKey?: Hex.Hex): Promise<Account> {
  const pk = privateKey ?? Secp256k1.randomPrivateKey();
  const publicKey = Secp256k1.getPublicKey({ privateKey: pk });
  const address = Address.fromPublicKey(publicKey);
  const accountHex =
    `0x000000000000000000000000${address.slice(2).toLowerCase()}` as Hex.Hex;

  const state = await fetchState();
  const existing = state.accounts[accountHex];

  if (!existing || existing.keys.length === 0) {
    const mutation = {
      expiry: 0,
      rootKeyType: 2,
      keyType: 2,
      permissions: 0xff,
      rootPublicKey: accountHex,
      publicKey: accountHex,
    };
    const rawSignature = sign(pk, "Initialize", {
      account: accountHex,
      ...mutation,
    });
    await post("/api/initialize", {
      ...mutation,
      account: accountHex,
      keyId: 0,
      nonce: "0",
      deadline: FAR_DEADLINE.toString(),
      rawSignature,
    });
  }

  return {
    privateKey: pk,
    address,
    accountHex,
    keyId: 1,
    nonceKey: randomNonceKey(),
    seq: 0n,
  };
}

export async function fetchState(): Promise<State> {
  const res = await fetch(`${API_URL}/api/state`);
  return res.json() as Promise<State>;
}

export async function addInstrument(
  account: Account,
  instrument: {
    instrumentId: number;
    base: Address.Address;
    quote: Address.Address;
    baseLotExp: number;
    quoteLotExp: number;
  },
  opts?: MutationOpts,
) {
  const { nonce, rollback } = reserveNonce(account, opts);
  const rawSignature = sign(account.privateKey, "AddInstrument", {
    instrumentId: BigInt(instrument.instrumentId),
    base: instrument.base,
    quote: instrument.quote,
    baseLotExp: instrument.baseLotExp,
    quoteLotExp: instrument.quoteLotExp,
    nonce,
    deadline: FAR_DEADLINE,
  });
  return postWithNonce(rollback, "/api/add-instrument", {
    ...instrument,
    account: account.accountHex,
    keyId: account.keyId,
    nonce,
    deadline: FAR_DEADLINE,
    rawSignature,
  });
}

export async function deposit(
  account: Account,
  params: { quantity: TokenAmount },
  opts?: MutationOpts,
) {
  const { quantity } = params;
  const { nonce, rollback } = reserveNonce(account, opts);
  const rawSignature = sign(account.privateKey, "Deposit", {
    asset: quantity.asset,
    amount: quantity.raw,
    nonce,
    deadline: FAR_DEADLINE,
  });
  return postWithNonce(rollback, "/api/mint", {
    asset: quantity.asset,
    amount: quantity.raw,
    account: account.accountHex,
    keyId: account.keyId,
    nonce,
    deadline: FAR_DEADLINE,
    rawSignature,
  });
}

export async function limitOrder(
  account: Account,
  params: {
    instrument: InstrumentConfig;
    price: number;
    side: "buy" | "sell";
    quantity: TokenAmount;
  },
  opts?: MutationOpts,
) {
  const { instrument } = params;
  const bidOrAsk = params.side === "buy" ? 0 : 1;
  const q32Price = priceToQ32(params.price, instrument);
  const quantity = lotAligned(params.quantity.raw, instrument.baseLotExp);
  const { nonce, rollback } = reserveNonce(account, opts);
  const rawSignature = sign(account.privateKey, "LimitOrder", {
    quantity,
    instrumentId: BigInt(instrument.id),
    price: q32Price,
    bidOrAsk,
    nonce,
    deadline: FAR_DEADLINE,
  });
  return postWithNonce(rollback, "/api/limit-order", {
    quantity,
    instrumentId: instrument.id,
    price: q32Price,
    bidOrAsk,
    account: account.accountHex,
    keyId: account.keyId,
    nonce,
    deadline: FAR_DEADLINE,
    rawSignature,
  });
}

export async function marketOrder(
  account: Account,
  params: {
    instrument: InstrumentConfig;
    side: "buy" | "sell";
    quantity: TokenAmount;
    minReceived: TokenAmount;
  },
  opts?: MutationOpts,
) {
  const { instrument } = params;
  const bidOrAsk = params.side === "buy" ? 0 : 1;
  const quantity = lotAligned(params.quantity.raw, instrument.baseLotExp);
  const receivedLotExp =
    params.side === "buy" ? instrument.baseLotExp : instrument.quoteLotExp;
  const minReceivedQuantity = lotAligned(
    params.minReceived.raw,
    receivedLotExp,
  );
  const { nonce, rollback } = reserveNonce(account, opts);
  const rawSignature = sign(account.privateKey, "MarketOrder", {
    quantity,
    minReceivedQuantity,
    instrumentId: BigInt(instrument.id),
    bidOrAsk,
    nonce,
    deadline: FAR_DEADLINE,
  });
  return postWithNonce(rollback, "/api/market-order", {
    quantity,
    minReceivedQuantity,
    instrumentId: instrument.id,
    bidOrAsk,
    account: account.accountHex,
    keyId: account.keyId,
    nonce,
    deadline: FAR_DEADLINE,
    rawSignature,
  });
}

export async function closeOrder(
  account: Account,
  params: { orderId: number },
  opts?: MutationOpts,
) {
  const { nonce, rollback } = reserveNonce(account, opts);
  const rawSignature = sign(account.privateKey, "CloseOrder", {
    orderId: BigInt(params.orderId),
    nonce,
    deadline: FAR_DEADLINE,
  });
  return postWithNonce(rollback, "/api/close-order", {
    ...params,
    account: account.accountHex,
    keyId: account.keyId,
    nonce,
    deadline: FAR_DEADLINE,
    rawSignature,
  });
}

export async function withdraw(
  account: Account,
  params: { quantity: TokenAmount },
  opts?: MutationOpts,
) {
  const { quantity } = params;
  const { nonce, rollback } = reserveNonce(account, opts);
  const rawSignature = sign(account.privateKey, "Withdrawal", {
    asset: quantity.asset,
    amount: quantity.raw,
    nonce,
    deadline: FAR_DEADLINE,
  });
  return postWithNonce(rollback, "/api/withdrawal", {
    asset: quantity.asset,
    amount: quantity.raw,
    account: account.accountHex,
    keyId: account.keyId,
    nonce,
    deadline: FAR_DEADLINE,
    rawSignature,
  });
}
