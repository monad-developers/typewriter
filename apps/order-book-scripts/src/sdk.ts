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

type InstrumentConfig = {
  id: number;
  base: Address.Address;
  quote: Address.Address;
  baseLotExp: number;
  quoteLotExp: number;
  baseDecimals: number;
  quoteDecimals: number;
};

export type TokenAmount = {
  raw: bigint;
  human: number;
  asset: Address.Address;
  lots: bigint;
  side: "base" | "quote";
  instrument: InstrumentConfig;
};

export const TokenAmount = {
  from(
    human: number,
    instrument: InstrumentConfig,
    side: "base" | "quote",
  ): TokenAmount {
    const decimals = side === "base" ? instrument.baseDecimals : instrument.quoteDecimals;
    const lotExp = side === "base" ? instrument.baseLotExp : instrument.quoteLotExp;
    const asset = side === "base" ? instrument.base : instrument.quote;
    const raw = BigInt(Math.round(human * 10 ** decimals));
    const lots = raw >> BigInt(lotExp);
    return { raw, human, asset, lots, side, instrument };
  },

  fromRaw(
    raw: bigint,
    instrument: InstrumentConfig,
    side: "base" | "quote",
  ): TokenAmount {
    const decimals = side === "base" ? instrument.baseDecimals : instrument.quoteDecimals;
    const lotExp = side === "base" ? instrument.baseLotExp : instrument.quoteLotExp;
    const asset = side === "base" ? instrument.base : instrument.quote;
    const human = Number(raw) / 10 ** decimals;
    const lots = raw >> BigInt(lotExp);
    return { raw, human, asset, lots, side, instrument };
  },
};

export function q32ToPrice(
  q32Price: bigint,
  instrument: InstrumentConfig,
): number {
  return (
    (Number(q32Price) /
      2 ** 32 /
      2 ** (instrument.quoteLotExp - instrument.quoteDecimals)) *
    2 ** (instrument.baseLotExp - instrument.baseDecimals)
  );
}

export function priceToQ32(
  price: number,
  instrument: InstrumentConfig,
): bigint {
  return BigInt(
    Math.round(
      (price *
        2 ** 32 *
        2 ** (instrument.quoteLotExp - instrument.quoteDecimals)) /
        2 ** (instrument.baseLotExp - instrument.baseDecimals),
    ),
  );
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
  amount: TokenAmount,
  opts?: MutationOpts,
) {
  const nonce = nextNonce(account, opts);
  const rawSignature = sign(account.privateKey, "Deposit", {
    asset: amount.asset,
    amount: amount.raw,
    nonce,
    deadline: FAR_DEADLINE,
  });
  return post("/api/mint", {
    asset: amount.asset,
    amount: amount.raw,
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
    amount: TokenAmount;
    price: number;
    side: "buy" | "sell";
  },
  opts?: MutationOpts,
) {
  const instrument = params.amount.instrument;
  const bidOrAsk = params.side === "buy" ? 0 : 1;
  const q32Price = priceToQ32(params.price, instrument);
  const nonce = nextNonce(account, opts);
  const rawSignature = sign(account.privateKey, "LimitOrder", {
    quantity: params.amount.lots,
    instrumentId: BigInt(instrument.id),
    price: q32Price,
    bidOrAsk,
    nonce,
    deadline: FAR_DEADLINE,
  });
  return post("/api/limit-order", {
    quantity: params.amount.lots,
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
    amount: TokenAmount;
    minReceived: TokenAmount;
    side: "buy" | "sell";
  },
  opts?: MutationOpts,
) {
  const instrument = params.amount.instrument;
  const bidOrAsk = params.side === "buy" ? 0 : 1;
  const nonce = nextNonce(account, opts);
  const rawSignature = sign(account.privateKey, "MarketOrder", {
    quantity: params.amount.lots,
    minReceivedQuantity: params.minReceived.lots,
    instrumentId: BigInt(instrument.id),
    bidOrAsk,
    nonce,
    deadline: FAR_DEADLINE,
  });
  return post("/api/market-order", {
    quantity: params.amount.lots,
    minReceivedQuantity: params.minReceived.lots,
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
  amount: TokenAmount,
  opts?: MutationOpts,
) {
  const nonce = nextNonce(account, opts);
  const rawSignature = sign(account.privateKey, "Withdrawal", {
    asset: amount.asset,
    amount: amount.raw,
    nonce,
    deadline: FAR_DEADLINE,
  });
  return post("/api/withdrawal", {
    asset: amount.asset,
    amount: amount.raw,
    account: account.accountHex,
    keyId: account.keyId,
    nonce,
    deadline: FAR_DEADLINE,
    rawSignature,
  });
}
