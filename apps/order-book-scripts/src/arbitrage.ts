import type { Instrument, State } from "order-book-backend/src/exchange";
import type { Address, Hex } from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  signTypedData,
} from "viem/accounts";
import { API_URL, CHAIN_ID, EIP712_TYPES, EXCHANGE_ADDRESS } from "./constants";
import { priceToQ32, q32ToPrice } from "./utils";

if (!process.env.PRICE) {
  console.error("PRICE env var is required (e.g. 2400 for $2400)");
  process.exit(1);
}

const pk = generatePrivateKey();
const wallet = privateKeyToAccount(pk);
const account =
  `0x000000000000000000000000${wallet.address.slice(2).toLowerCase()}` as Hex;

const instrumentId = Number(process.env.INSTRUMENT_ID ?? "0");
const inputPrice = Number(process.env.PRICE);
const baseDecimals = 18;
const quoteDecimals = 18;

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

async function initialize(nonce: bigint) {
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
    privateKey: pk,
    domain: domain(),
    types: EIP712_TYPES,
    primaryType: "Initialize",
    message: { account, ...mutation },
  });
  await post("/api/initialize", {
    ...mutation,
    account,
    keyId: 0,
    nonce: nonce.toString(),
    deadline: FAR_DEADLINE.toString(),
    rawSignature: sig,
  });
}

async function mint(asset: Address, amount: bigint, nonce: bigint) {
  const sig = await signTypedData({
    privateKey: pk,
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

async function marketOrder(
  quantity: bigint,
  minReceivedQuantity: bigint,
  bidOrAsk: 0 | 1,
  nonce: bigint,
) {
  const sig = await signTypedData({
    privateKey: pk,
    domain: domain(),
    types: EIP712_TYPES,
    primaryType: "MarketOrder",
    message: {
      quantity,
      minReceivedQuantity,
      instrumentId: BigInt(instrumentId),
      bidOrAsk,
      nonce,
      deadline: FAR_DEADLINE,
    },
  });
  return post("/api/market-order", {
    quantity,
    minReceivedQuantity,
    instrumentId,
    bidOrAsk,
    account,
    keyId: 1,
    nonce,
    deadline: FAR_DEADLINE,
    rawSignature: sig,
  });
}

function findArbOpportunity(
  instrument: Instrument,
  realQ32: bigint,
): {
  side: 0 | 1;
  quantity: bigint;
  minReceived: bigint;
} | null {
  const toPrice = (q32: number) =>
    q32ToPrice(BigInt(q32), instrument.baseLotExp, instrument.quoteLotExp, baseDecimals, quoteDecimals);

  const askPrices = Object.keys(instrument.asks)
    .map(Number)
    .sort((a, b) => a - b);
  const bidPrices = Object.keys(instrument.bids)
    .map(Number)
    .sort((a, b) => b - a);

  for (const p of askPrices) {
    if (BigInt(p) >= realQ32) break;
    const tick = instrument.asks[p]!;
    const remaining = BigInt(tick.remainingQuantity);
    if (remaining <= 0n) continue;

    console.log(
      `arb: buy ${remaining} lots @ $${toPrice(p).toFixed(4)} (below real price $${inputPrice})`,
    );
    return { side: 0, quantity: remaining, minReceived: remaining };
  }

  for (const p of bidPrices) {
    if (BigInt(p) <= realQ32) break;
    const tick = instrument.bids[p]!;
    const remaining = BigInt(tick.remainingQuantity);
    if (remaining <= 0n) continue;

    const minReceived = (remaining * BigInt(p)) >> 32n;
    console.log(
      `arb: sell ${remaining} lots @ $${toPrice(p).toFixed(4)} (above real price $${inputPrice})`,
    );
    return { side: 1, quantity: remaining, minReceived };
  }

  return null;
}

const state = await getState();
const instrument = state.instruments[instrumentId];
if (!instrument) {
  console.error(`instrument ${instrumentId} not found, run setup first`);
  process.exit(1);
}

const realQ32 = priceToQ32(
  inputPrice,
  instrument.baseLotExp,
  instrument.quoteLotExp,
  baseDecimals,
  quoteDecimals,
);
console.log(`real price: $${inputPrice} (Q32: ${realQ32})`);

const arb = findArbOpportunity(instrument, realQ32);
if (!arb) {
  console.log("no arbitrage opportunity found");
  process.exit(0);
}

let nonce = 0n;
await initialize(nonce);
console.log(`initialized account ${wallet.address}`);

const baseAsset = instrument.base as Address;
const quoteAsset = instrument.quote as Address;
const baseLotExp = BigInt(instrument.baseLotExp);
const quoteLotExp = BigInt(instrument.quoteLotExp);

if (arb.side === 0) {
  const maxCost = ((arb.quantity * realQ32) >> 32n) << quoteLotExp;
  console.log(`minting ${maxCost} quote to cover buy...`);
  await mint(quoteAsset, maxCost, nonce);
  nonce++;
} else {
  const rawBase = arb.quantity << baseLotExp;
  console.log(`minting ${rawBase} base to cover sell...`);
  await mint(baseAsset, rawBase, nonce);
  nonce++;
}

const result = await marketOrder(
  arb.quantity,
  arb.minReceived,
  arb.side,
  nonce,
);
console.log("market order filled:", result);
console.log("done");
