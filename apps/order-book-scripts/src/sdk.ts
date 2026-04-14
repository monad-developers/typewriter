import type { State } from "order-book-backend/src/exchange";
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

const EIP712_TYPES = {
  Initialize: [
    { name: "account", type: "bytes32" },
    { name: "expiry", type: "uint40" },
    { name: "rootKeyType", type: "uint8" },
    { name: "keyType", type: "uint8" },
    { name: "permissions", type: "uint8" },
    { name: "rootPublicKey", type: "bytes" },
    { name: "publicKey", type: "bytes" },
  ],
  Authorize: [
    { name: "account", type: "bytes32" },
    { name: "expiry", type: "uint40" },
    { name: "keyType", type: "uint8" },
    { name: "permissions", type: "uint8" },
    { name: "publicKey", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Deposit: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
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
  CloseOrder: [
    { name: "orderId", type: "uint64" },
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

function domain() {
  return {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: CHAIN_ID,
    verifyingContract: EXCHANGE_ADDRESS,
  };
}

function sign(
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

export type InstrumentConfig = {
  id: number;
  base: Address.Address;
  quote: Address.Address;
  baseLotExp: number;
  quoteLotExp: number;
};

const DECIMALS = 18;
const Q32 = 1n << 32n;

export type TokenAmount = {
  raw: bigint;
  human: number;
  asset: Address.Address;
};

export const TokenAmount = {
  from(human: number, asset: Address.Address): TokenAmount {
    const raw = BigInt(Math.round(human * 10 ** DECIMALS));
    return { raw, human, asset };
  },

  fromRaw(raw: bigint, asset: Address.Address): TokenAmount {
    const human = Number(raw) / 10 ** DECIMALS;
    return { raw, human, asset };
  },
};

function toLots(raw: bigint, lotExp: number): bigint {
  return raw >> BigInt(lotExp);
}

/** @dev humanPrice = q32Price * (2^-(32 + baseLotExp - quoteLotExp)) */
export function q32ToPrice(
  q32Price: bigint,
  instrument: InstrumentConfig,
): number {
  const integer = Number(q32Price >> 32n);
  const fractional = Number(q32Price & (Q32 - 1n)) / Number(Q32);
  const priceScaled = integer + fractional;
  const scale = 2 ** (instrument.quoteLotExp - instrument.baseLotExp);
  return priceScaled * scale;
}

/** @dev q32Price = humanPrice * 2^(32 + baseLotExp - quoteLotExp) */
export function priceToQ32(
  price: number,
  instrument: InstrumentConfig,
): bigint {
  const scale = 2 ** (instrument.baseLotExp - instrument.quoteLotExp);
  const priceScaled = price * scale;
  const integer = BigInt(Math.floor(priceScaled));
  const fractional = BigInt(
    Math.round((priceScaled - Number(integer)) * Number(Q32)),
  );
  return (integer << 32n) | fractional;
}

export function baseToQuote(
  quantity: TokenAmount,
  q32Price: bigint,
  instrument: InstrumentConfig,
): TokenAmount {
  const baseLots = toLots(quantity.raw, instrument.baseLotExp);
  const quoteLots = (baseLots * q32Price) >> 32n;
  const raw = quoteLots << BigInt(instrument.quoteLotExp);
  return TokenAmount.fromRaw(raw, instrument.quote);
}

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

function nextNonce(account: Account, opts?: MutationOpts): bigint {
  if (opts?.concurrent) {
    return randomNonceKey() << 64n;
  }
  const nonce = (account.nonceKey << 64n) | account.seq;
  account.seq++;
  return nonce;
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
      permissions: 0x7f,
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

export async function addInstrument(instrument: {
  instrumentId: number;
  base: Address.Address;
  quote: Address.Address;
  baseLotExp: number;
  quoteLotExp: number;
}) {
  return post("/api/add-instrument", instrument);
}

export async function deposit(
  account: Account,
  params: { quantity: TokenAmount },
  opts?: MutationOpts,
) {
  const { quantity } = params;
  const nonce = nextNonce(account, opts);
  const rawSignature = sign(account.privateKey, "Deposit", {
    asset: quantity.asset,
    amount: quantity.raw,
    nonce,
    deadline: FAR_DEADLINE,
  });
  return post("/api/mint", {
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
  const quantity = toLots(params.quantity.raw, instrument.baseLotExp);
  const nonce = nextNonce(account, opts);
  const rawSignature = sign(account.privateKey, "LimitOrder", {
    quantity,
    instrumentId: BigInt(instrument.id),
    price: q32Price,
    bidOrAsk,
    nonce,
    deadline: FAR_DEADLINE,
  });
  return post("/api/limit-order", {
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
  const quantity = toLots(params.quantity.raw, instrument.baseLotExp);
  const minReceivedQuantity = toLots(
    params.minReceived.raw,
    params.side === "buy" ? instrument.baseLotExp : instrument.quoteLotExp,
  );
  const nonce = nextNonce(account, opts);
  const rawSignature = sign(account.privateKey, "MarketOrder", {
    quantity,
    minReceivedQuantity,
    instrumentId: BigInt(instrument.id),
    bidOrAsk,
    nonce,
    deadline: FAR_DEADLINE,
  });
  return post("/api/market-order", {
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
  const nonce = nextNonce(account, opts);
  const rawSignature = sign(account.privateKey, "CloseOrder", {
    orderId: BigInt(params.orderId),
    nonce,
    deadline: FAR_DEADLINE,
  });
  return post("/api/close-order", {
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
  const nonce = nextNonce(account, opts);
  const rawSignature = sign(account.privateKey, "Withdrawal", {
    asset: quantity.asset,
    amount: quantity.raw,
    nonce,
    deadline: FAR_DEADLINE,
  });
  return post("/api/withdrawal", {
    asset: quantity.asset,
    amount: quantity.raw,
    account: account.accountHex,
    keyId: account.keyId,
    nonce,
    deadline: FAR_DEADLINE,
    rawSignature,
  });
}
