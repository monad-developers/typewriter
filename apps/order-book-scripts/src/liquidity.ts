import type { State } from "order-book-backend/src/exchange";
import type { Address, Hex } from "viem";
import { privateKeyToAccount, signTypedData } from "viem/accounts";

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "31337");
const EXCHANGE_ADDRESS = (process.env.EXCHANGE_ADDRESS ??
  "0x5fbdb2315678afecb367f032d93f642f64180aa3") as Address;

const pk = process.env.PRIVATE_KEY as Hex | undefined;
if (!pk) {
  console.error("PRIVATE_KEY env var is required");
  process.exit(1);
}
if (!process.env.PRICE) {
  console.error("PRICE env var is required (Q32 bigint)");
  process.exit(1);
}
if (!process.env.SIDE) {
  console.error("SIDE env var is required (0 = bid, 1 = ask)");
  process.exit(1);
}

const wallet = privateKeyToAccount(pk);
const account =
  `0x000000000000000000000000${wallet.address.slice(2).toLowerCase()}` as Hex;

const instrumentId = Number(process.env.INSTRUMENT_ID ?? "0");
const price = BigInt(process.env.PRICE);
const side = Number(process.env.SIDE) as 0 | 1;
const quantity = BigInt(process.env.QUANTITY ?? "100");

// Duplicated from order-book-backend/src/constants.ts because that module
// throws on missing env vars at import time.
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
} as const;

const FAR_DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 86400);

function domain() {
  return {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: CHAIN_ID,
    verifyingContract: EXCHANGE_ADDRESS,
  };
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} failed: ${data.error}`);
  return data;
}

async function getState(): Promise<State> {
  const res = await fetch(`${API_URL}/api/state`);
  return res.json() as Promise<State>;
}

async function initialize() {
  const pubKey = account;
  const mutation = {
    expiry: 0,
    rootKeyType: 2,
    keyType: 2,
    permissions: 0x7f,
    rootPublicKey: pubKey,
    publicKey: pubKey,
  };
  const sig = await signTypedData({
    privateKey: pk!,
    domain: domain(),
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account, ...mutation },
  });
  await post("/api/initialize", {
    ...mutation,
    account,
    keyId: 0,
    nonce: "0",
    deadline: FAR_DEADLINE.toString(),
    rawSignature: sig,
  });
  console.log(`initialized account ${wallet.address}`);
}

async function mint(asset: Address, amount: bigint, nonce: bigint) {
  const sig = await signTypedData({
    privateKey: pk!,
    domain: domain(),
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: { asset, amount, nonce, deadline: FAR_DEADLINE },
  });
  await post("/api/mint", {
    asset,
    amount,
    account,
    keyId: 1,
    nonce,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
  });
}

async function limitOrder(
  q: bigint,
  p: bigint,
  bidOrAsk: 0 | 1,
  nonce: bigint,
) {
  const sig = await signTypedData({
    privateKey: pk!,
    domain: domain(),
    types: EIP712_TYPES,
    primaryType: "LimitOrder",
    message: {
      quantity: q,
      instrumentId: BigInt(instrumentId),
      price: p,
      bidOrAsk,
      nonce,
      deadline: FAR_DEADLINE,
    },
  });
  await post("/api/limit-order", {
    quantity: q,
    instrumentId,
    price: p,
    bidOrAsk,
    account,
    keyId: 1,
    nonce,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
  });
}

const state = await getState();
const instrument = state.instruments[instrumentId];
if (!instrument) {
  console.error(`instrument ${instrumentId} not found, run setup first`);
  process.exit(1);
}

const existingAccount = state.accounts[account];
if (!existingAccount || existingAccount.keys.length === 0) {
  await initialize();
}

let nonce = BigInt(existingAccount?.nonces?.["0"] ?? "0");

const baseAsset = instrument.base as Address;
const quoteAsset = instrument.quote as Address;
const baseLotExp = BigInt(instrument.baseLotExp);
const quoteLotExp = BigInt(instrument.quoteLotExp);

if (side === 1) {
  const rawBase = quantity << baseLotExp;
  console.log(`minting ${rawBase} base (${baseAsset})...`);
  await mint(baseAsset, rawBase, nonce);
  nonce++;
} else {
  const rawQuote = ((quantity * price) >> 32n) << quoteLotExp;
  console.log(`minting ${rawQuote} quote (${quoteAsset})...`);
  await mint(quoteAsset, rawQuote, nonce);
  nonce++;
}

const label = side === 0 ? "bid" : "ask";
console.log(`placing ${label}: ${quantity} lots @ Q32 price ${price}...`);
await limitOrder(quantity, price, side, nonce);

console.log("done");
