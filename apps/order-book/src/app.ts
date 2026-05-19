import { and, asc, eq, sql } from "drizzle-orm";
import { type FFCAConfig, verifySignature as verifyKeySignature } from "ffca";
import type { AsyncSlotGetter, StorageProxy } from "storage-layout";
import {
  encodeAbiParameters,
  type Hex,
  keccak256,
  parseAbiParameters,
  parseSignature,
} from "viem";
import * as schema from "./app-schema";
import {
  type AddInstrument,
  ALL_PERMISSIONS,
  type Authorize,
  type ChangeOrder,
  type CloseOrder,
  type Deposit,
  getNonceSeq,
  handleAddInstrument,
  handleAuthorize,
  handleChangeOrder,
  handleCloseOrder,
  handleDeposit,
  handleInitialize,
  handleLimitOrder,
  handleMarketOrder,
  handleRevoke,
  handleWithdrawal,
  type Initialize,
  incrementNonce,
  type LimitOrder,
  type MarketOrder,
  type MarketOrderResolution,
  MutationType,
  PERM_ADD_INSTRUMENT,
  PERM_AUTHORIZE,
  PERM_CHANGE_ORDER,
  PERM_CLOSE_ORDER,
  PERM_DEPOSIT,
  PERM_LIMIT_ORDER,
  PERM_MARKET_ORDER,
  PERM_REVOKE,
  PERM_WITHDRAW,
  type Revoke,
  type State,
  toLots,
  type Withdrawal,
} from "./exchange";
import type { EXCHANGE_STORAGE_LAYOUT } from "./storage-layout";

type OrderBookState = State<bigint>;
type OrderBookStorage = StorageProxy<
  typeof EXCHANGE_STORAGE_LAYOUT,
  AsyncSlotGetter
>;
type KnownPriceLevels = Map<number, { bids: Set<number>; asks: Set<number> }>;
const UINT64_MASK = 0xffffffffffffffffn;

export const ORDER_BOOK_SIGNATURE_PARAMS = parseAbiParameters(
  "bytes32 account, uint64 keyId, bytes rawSignature",
);

export type OrderBookSignature = {
  account: Hex;
  keyId: bigint;
  rawSignature: Hex;
};

type AccountArg = { account: Hex };
type SignedArgs = { nonce: bigint; deadline: bigint };

export type InitializeArgs = Initialize & AccountArg;
export type AuthorizeArgs = Authorize & AccountArg & SignedArgs;
export type RevokeArgs = Revoke & AccountArg & SignedArgs;
export type CloseOrderArgs = CloseOrder & SignedArgs;
export type ChangeOrderArgs = ChangeOrder<bigint> & SignedArgs;
export type LimitOrderArgs = LimitOrder<bigint> & SignedArgs;
export type MarketOrderArgs = MarketOrder<bigint> & SignedArgs;
export type AddInstrumentArgs = AddInstrument & SignedArgs;
export type DepositArgs = Deposit<bigint> & SignedArgs;
export type WithdrawalArgs = Withdrawal<bigint> & SignedArgs;

export type OrderBookMutationName =
  | "Initialize"
  | "Authorize"
  | "Revoke"
  | "CloseOrder"
  | "ChangeOrder"
  | "LimitOrder"
  | "MarketOrder"
  | "AddInstrument"
  | "Deposit"
  | "Withdrawal";

export type SubmittedOrderBookMutation = {
  name: OrderBookMutationName;
  args:
    | InitializeArgs
    | AuthorizeArgs
    | RevokeArgs
    | CloseOrderArgs
    | ChangeOrderArgs
    | LimitOrderArgs
    | MarketOrderArgs
    | AddInstrumentArgs
    | DepositArgs
    | WithdrawalArgs;
  signature: OrderBookSignature;
};

export const ORDER_BOOK_SEQUENCE = [
  "Initialize",
  "Authorize",
  "Revoke",
  "CloseOrder",
  "ChangeOrder",
  "LimitOrder",
  "MarketOrder",
  "AddInstrument",
  "Deposit",
  "Withdrawal",
] as const;

function verifyInitializeSignature(
  args: InitializeArgs,
  signature: OrderBookSignature,
): void {
  const expected = keccak256(args.rootPublicKey);
  if (signature.account.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `InvalidAccount: account=${signature.account}, expected=${expected}`,
    );
  }
}

function verifySignedMutation(
  state: OrderBookState,
  signature: OrderBookSignature,
  args: SignedArgs,
  digest: Hex,
  permission: number,
): void {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (args.deadline < now) {
    throw new Error(
      `SignatureExpired: deadline=${args.deadline}, now=${now}, account=${signature.account}`,
    );
  }

  const acc = state.accounts[signature.account];
  const key = acc?.keys[Number(signature.keyId)];
  if (acc === undefined || key === undefined || key.permissions === 0) {
    throw new Error(
      `KeyNotFound: account=${signature.account}, keyId=${signature.keyId}`,
    );
  }
  if (key.expiry !== 0 && BigInt(key.expiry) < now) {
    throw new Error(
      `KeyExpired: account=${signature.account}, keyId=${signature.keyId}, expiry=${key.expiry}, now=${now}`,
    );
  }

  verifyKeySignature(
    key.keyType,
    digest,
    key.publicKey,
    signature.rawSignature,
  );

  const nonceKey = args.nonce >> 64n;
  const nonceSeq = args.nonce & UINT64_MASK;
  const stored = getNonceSeq(acc, nonceKey);
  if (nonceSeq !== stored) {
    throw new Error(
      `InvalidNonce: account=${signature.account}, expected=${stored}, got=${nonceSeq}, nonceKey=${nonceKey}`,
    );
  }
  incrementNonce(acc, nonceKey);

  if ((key.permissions & permission) !== permission) {
    throw new Error(
      `Unauthorized: account=${signature.account}, keyId=${signature.keyId}, permissions=${key.permissions}, required=${permission}`,
    );
  }
}

function applyInitialize(
  state: OrderBookState,
  args: InitializeArgs,
  signature: OrderBookSignature,
): void {
  verifyInitializeSignature(args, signature);
  handleInitialize(state, args, signature.account);
}

function applyAuthorize(
  state: OrderBookState,
  args: AuthorizeArgs,
  signature: OrderBookSignature,
  digest: Hex,
): void {
  verifySignedMutation(state, signature, args, digest, PERM_AUTHORIZE);
  handleAuthorize(state, args, signature.account);
}

function applyRevoke(
  state: OrderBookState,
  args: RevokeArgs,
  signature: OrderBookSignature,
  digest: Hex,
): void {
  verifySignedMutation(state, signature, args, digest, PERM_REVOKE);
  handleRevoke(state, args, signature.account);
}

function applyCloseOrder(
  state: OrderBookState,
  args: CloseOrderArgs,
  signature: OrderBookSignature,
  digest: Hex,
): void {
  verifySignedMutation(state, signature, args, digest, PERM_CLOSE_ORDER);
  handleCloseOrder(state, args, signature.account);
}

function applyLimitOrder(
  state: OrderBookState,
  args: LimitOrderArgs,
  signature: OrderBookSignature,
  digest: Hex,
): void {
  verifySignedMutation(state, signature, args, digest, PERM_LIMIT_ORDER);
  handleLimitOrder(state, args, signature.account);
}

function applyChangeOrder(
  state: OrderBookState,
  args: ChangeOrderArgs,
  signature: OrderBookSignature,
  digest: Hex,
): void {
  verifySignedMutation(state, signature, args, digest, PERM_CHANGE_ORDER);
  handleChangeOrder(state, args, signature.account);
}

function applyMarketOrder(
  state: OrderBookState,
  args: MarketOrderArgs,
  resolution: MarketOrderResolution<bigint>,
  signature: OrderBookSignature,
  digest: Hex,
): void {
  verifySignedMutation(state, signature, args, digest, PERM_MARKET_ORDER);
  handleMarketOrder(state, args, resolution, signature.account);
}

function applyAddInstrument(
  state: OrderBookState,
  args: AddInstrumentArgs,
  signature: OrderBookSignature,
  digest: Hex,
): void {
  verifySignedMutation(state, signature, args, digest, PERM_ADD_INSTRUMENT);
  handleAddInstrument(state, args);
}

function applyDeposit(
  state: OrderBookState,
  args: DepositArgs,
  signature: OrderBookSignature,
  digest: Hex,
): void {
  verifySignedMutation(state, signature, args, digest, PERM_DEPOSIT);
  handleDeposit(state, args, signature.account);
}

function applyWithdrawal(
  state: OrderBookState,
  args: WithdrawalArgs,
  signature: OrderBookSignature,
  digest: Hex,
): void {
  verifySignedMutation(state, signature, args, digest, PERM_WITHDRAW);
  handleWithdrawal(state, args, signature.account);
}

async function resolveMarket(
  storage: OrderBookStorage,
  args: MarketOrderArgs,
  knownPriceLevels: KnownPriceLevels,
): Promise<MarketOrderResolution<bigint>> {
  const priceLevels = knownPriceLevels.get(args.instrumentId);
  const prices = [
    ...((args.bidOrAsk === 0 ? priceLevels?.asks : priceLevels?.bids) ?? []),
  ].sort((a, b) => (args.bidOrAsk === 0 ? a - b : b - a));

  const instrument =
    storage.instruments[String(args.instrumentId) as `${number}`];
  const opposingSide = args.bidOrAsk === 0 ? instrument.asks : instrument.bids;
  const baseLotExp = await instrument.baseLotExp;
  const fills: { quantity: bigint; price: bigint }[] = [];
  const quantityLots = args.quantity >> BigInt(baseLotExp);
  let remaining = quantityLots;

  for (const price of prices) {
    if (remaining <= 0n) break;
    const tick = opposingSide[String(price) as `${number}`];
    const available = await tick.remainingQuantity;
    if (available <= 0n) continue;

    const quantity = remaining < available ? remaining : available;
    fills.push({ quantity, price: BigInt(price) });
    remaining -= quantity;
  }

  if (remaining > 0n) {
    throw new Error(
      `InsufficientLiquidity: resolveMarket totalFilled=${quantityLots - remaining} quantityLots=${quantityLots} fillCount=${fills.length} instrumentId=${args.instrumentId}`,
    );
  }

  return { fills };
}

function rememberLimitPrice(
  knownPriceLevels: KnownPriceLevels,
  args: LimitOrderArgs,
): void {
  const levels = knownPriceLevels.get(args.instrumentId) ?? {
    bids: new Set<number>(),
    asks: new Set<number>(),
  };
  knownPriceLevels.set(args.instrumentId, levels);
  const side = args.bidOrAsk === 0 ? levels.bids : levels.asks;
  side.add(Number(args.price));
}

export function createKnownPriceLevels(): KnownPriceLevels {
  return new Map();
}

function rememberLoadedTicks(
  knownPriceLevels: KnownPriceLevels,
  state: OrderBookState,
): void {
  knownPriceLevels.clear();
  for (const [instrumentId, instrument] of Object.entries(state.instruments)) {
    const levels = { bids: new Set<number>(), asks: new Set<number>() };
    for (const [price, tick] of Object.entries(instrument.bids)) {
      if (tick.remainingQuantity > 0n) levels.bids.add(Number(price));
    }
    for (const [price, tick] of Object.entries(instrument.asks)) {
      if (tick.remainingQuantity > 0n) levels.asks.add(Number(price));
    }
    if (levels.bids.size > 0 || levels.asks.size > 0) {
      knownPriceLevels.set(Number(instrumentId), levels);
    }
  }
}

export function baseMutations(
  knownPriceLevels: KnownPriceLevels = createKnownPriceLevels(),
): FFCAConfig["mutations"] {
  return {
    Initialize: {
      tag: MutationType.Initialize,
      table: schema.initializes,
      params: parseAbiParameters(
        "bytes32 account, uint40 expiry, uint8 rootKeyType, uint8 keyType, uint16 permissions, bytes rootPublicKey, bytes publicKey",
      ),
      apply: ({
        state,
        args,
        signature,
      }: {
        state: unknown;
        args: unknown;
        signature: unknown;
        digest: Hex;
      }) =>
        applyInitialize(
          state as OrderBookState,
          args as InitializeArgs,
          signature as OrderBookSignature,
        ),
    },
    Authorize: {
      tag: MutationType.Authorize,
      table: schema.authorizes,
      params: parseAbiParameters(
        "bytes32 account, uint40 expiry, uint8 keyType, uint16 permissions, bytes publicKey, uint256 nonce, uint256 deadline",
      ),
      apply: ({
        state,
        args,
        signature,
        digest,
      }: {
        state: unknown;
        args: unknown;
        signature: unknown;
        digest: Hex;
      }) =>
        applyAuthorize(
          state as OrderBookState,
          args as AuthorizeArgs,
          signature as OrderBookSignature,
          digest,
        ),
    },
    Revoke: {
      tag: MutationType.Revoke,
      table: schema.revokes,
      params: parseAbiParameters(
        "bytes32 account, uint64 keyId, uint256 nonce, uint256 deadline",
      ),
      apply: ({
        state,
        args,
        signature,
        digest,
      }: {
        state: unknown;
        args: unknown;
        signature: unknown;
        digest: Hex;
      }) =>
        applyRevoke(
          state as OrderBookState,
          args as RevokeArgs,
          signature as OrderBookSignature,
          digest,
        ),
    },
    CloseOrder: {
      tag: MutationType.CloseOrder,
      table: schema.closeOrders,
      params: parseAbiParameters(
        "uint64 orderId, uint256 nonce, uint256 deadline",
      ),
      apply: ({
        state,
        args,
        signature,
        digest,
      }: {
        state: unknown;
        args: unknown;
        signature: unknown;
        digest: Hex;
      }) =>
        applyCloseOrder(
          state as OrderBookState,
          args as CloseOrderArgs,
          signature as OrderBookSignature,
          digest,
        ),
    },
    ChangeOrder: {
      tag: MutationType.ChangeOrder,
      table: schema.changeOrders,
      params: parseAbiParameters(
        "uint64 orderId, uint64 price, uint256 nonce, uint256 deadline",
      ),
      apply: ({
        state,
        args,
        signature,
        digest,
      }: {
        state: unknown;
        args: unknown;
        signature: unknown;
        digest: Hex;
      }) =>
        applyChangeOrder(
          state as OrderBookState,
          args as ChangeOrderArgs,
          signature as OrderBookSignature,
          digest,
        ),
    },
    LimitOrder: {
      tag: MutationType.LimitOrder,
      table: schema.limitOrders,
      params: parseAbiParameters(
        "uint256 quantity, uint64 instrumentId, uint64 price, uint8 bidOrAsk, uint256 nonce, uint256 deadline",
      ),
      apply: ({
        state,
        args,
        signature,
        digest,
      }: {
        state: unknown;
        args: unknown;
        signature: unknown;
        digest: Hex;
      }) => {
        applyLimitOrder(
          state as OrderBookState,
          args as LimitOrderArgs,
          signature as OrderBookSignature,
          digest,
        );
        rememberLimitPrice(knownPriceLevels, args as LimitOrderArgs);
      },
    },
    MarketOrder: {
      tag: MutationType.MarketOrder,
      table: schema.marketOrders,
      params: parseAbiParameters(
        "uint256 quantity, uint256 minReceivedQuantity, uint64 instrumentId, uint8 bidOrAsk, uint256 nonce, uint256 deadline",
      ),
      resolution: parseAbiParameters("(uint64 quantity, uint64 price)[] fills"),
      resolve: ({
        state,
        args,
      }: {
        state: unknown;
        args: unknown;
        signature: unknown;
        bundle: readonly { name: string; args: unknown }[];
      }) =>
        resolveMarket(
          state as OrderBookStorage,
          args as MarketOrderArgs,
          knownPriceLevels,
        ),
      apply: ({
        state,
        args,
        resolution,
        signature,
        digest,
      }: {
        state: unknown;
        args: unknown;
        signature: unknown;
        digest: Hex;
        resolution: unknown;
      }) =>
        applyMarketOrder(
          state as OrderBookState,
          args as MarketOrderArgs,
          resolution as MarketOrderResolution<bigint>,
          signature as OrderBookSignature,
          digest,
        ),
    },
    AddInstrument: {
      tag: MutationType.AddInstrument,
      table: schema.addInstruments,
      params: parseAbiParameters(
        "uint64 instrumentId, address base, address quote, uint8 baseLotExp, uint8 quoteLotExp, uint256 nonce, uint256 deadline",
      ),
      apply: ({
        state,
        args,
        signature,
        digest,
      }: {
        state: unknown;
        args: unknown;
        signature: unknown;
        digest: Hex;
      }) =>
        applyAddInstrument(
          state as OrderBookState,
          args as AddInstrumentArgs,
          signature as OrderBookSignature,
          digest,
        ),
    },
    Deposit: {
      tag: MutationType.Deposit,
      table: schema.deposits,
      params: parseAbiParameters(
        "address asset, uint256 amount, uint256 nonce, uint256 deadline",
      ),
      apply: ({
        state,
        args,
        signature,
        digest,
      }: {
        state: unknown;
        args: unknown;
        signature: unknown;
        digest: Hex;
      }) =>
        applyDeposit(
          state as OrderBookState,
          args as DepositArgs,
          signature as OrderBookSignature,
          digest,
        ),
    },
    Withdrawal: {
      tag: MutationType.Withdrawal,
      table: schema.withdrawals,
      params: parseAbiParameters(
        "address asset, uint256 amount, uint256 nonce, uint256 deadline",
      ),
      apply: ({
        state,
        args,
        signature,
        digest,
      }: {
        state: unknown;
        args: unknown;
        signature: unknown;
        digest: Hex;
      }) =>
        applyWithdrawal(
          state as OrderBookState,
          args as WithdrawalArgs,
          signature as OrderBookSignature,
          digest,
        ),
    },
  };
}

export function normalizeSignatureForContract(
  state: OrderBookState,
  signature: OrderBookSignature,
): OrderBookSignature {
  const key = state.accounts[signature.account]?.keys[Number(signature.keyId)];
  if (key?.keyType !== 2 || signature.rawSignature.length !== 132) {
    return signature;
  }

  const { v, r, s } = parseSignature(signature.rawSignature);
  return {
    ...signature,
    rawSignature: encodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
      [Number(v), r, s],
    ),
  };
}

function txDb(tx: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: app persistence works across Drizzle transaction shapes
  return tx as any;
}

export async function loadOrderBookState(
  tx: Parameters<NonNullable<FFCAConfig["state"]["load"]>>[0],
  knownPriceLevels?: KnownPriceLevels,
): Promise<OrderBookState> {
  const state: OrderBookState = { accounts: {}, instruments: {} };
  const db = txDb(tx);

  const accounts = await db.select().from(schema.accounts);
  for (const row of accounts) {
    state.accounts[row.id as Hex] = {
      nonces: {},
      balances: {},
      keys: [],
      orders: [],
    };
  }

  const keys = await db
    .select()
    .from(schema.keys)
    .orderBy(asc(schema.keys.keyIndex));
  for (const row of keys) {
    const account = state.accounts[row.account as Hex];
    if (account === undefined) continue;
    account.keys[Number(row.keyIndex)] = {
      expiry: row.expiry,
      keyType: row.keyType,
      permissions: row.permissions,
      publicKey: row.publicKey as Hex,
    };
  }

  const nonces = await db.select().from(schema.nonces);
  for (const row of nonces) {
    const account = state.accounts[row.account as Hex];
    if (account === undefined) continue;
    account.nonces[row.nonceKey] = row.sequence;
  }

  const balances = await db.select().from(schema.balances);
  for (const row of balances) {
    const account = state.accounts[row.account as Hex];
    if (account === undefined) continue;
    account.balances[row.asset as Hex] = BigInt(row.amount);
  }

  const instruments = await db.select().from(schema.instruments);
  for (const row of instruments) {
    state.instruments[Number(row.id)] = {
      base: row.base as Hex,
      baseLotExp: row.baseLotExp,
      quote: row.quote as Hex,
      quoteLotExp: row.quoteLotExp,
      bids: {},
      asks: {},
    };
  }

  const orders = await db
    .select()
    .from(schema.orders)
    .orderBy(asc(schema.orders.orderIndex));
  for (const row of orders) {
    const account = state.accounts[row.account as Hex];
    if (account === undefined) continue;
    account.orders[Number(row.orderIndex)] = {
      quantity: row.quantity,
      instrumentId: Number(row.instrumentId),
      price: row.price,
      tickVolume: row.tickVolume,
      side: row.side,
    };
  }

  const ticks = await db.select().from(schema.ticks);
  for (const row of ticks) {
    const instrument = state.instruments[Number(row.instrumentId)];
    if (instrument === undefined) continue;
    const side = row.side === 0 ? instrument.bids : instrument.asks;
    side[Number(row.price)] = {
      quantity: row.quantity,
      remainingQuantity: row.remainingQuantity,
      volume: row.volume,
    };
  }

  if (knownPriceLevels !== undefined) {
    rememberLoadedTicks(knownPriceLevels, state);
  }

  return state;
}

function mutationArgs<T>(mutation: { args: unknown }): T {
  return mutation.args as T;
}

function mutationSignature(mutation: {
  signature: unknown;
}): OrderBookSignature {
  return mutation.signature as OrderBookSignature;
}

function baseMutationRow(
  mutation: { id: number; status: string; args: unknown; signature: unknown },
  bundle: { id: number; mutationIndex: number },
) {
  const signature = mutationSignature(mutation);
  const args = mutation.args as Partial<AccountArg>;
  return {
    id: mutation.id,
    bundleId: bundle.id,
    bundlePosition: bundle.mutationIndex,
    status: mutation.status,
    account: signature.account,
    keyId: signature.keyId,
    rawSignature: signature.rawSignature,
    accountArg: args.account ?? signature.account,
  };
}

async function persistLifecycle(
  tx: unknown,
  params: Parameters<
    NonNullable<FFCAConfig["mutations"][string]["persistLifecycle"]>
  >[1],
  table: unknown,
) {
  const db = txDb(tx);
  // biome-ignore lint/suspicious/noExplicitAny: generic lifecycle hook updates any mutation table
  const mutationTable = table as any;
  switch (params.lifecycle) {
    case "included":
      await db
        .update(table)
        .set({
          status: params.lifecycle,
          blockNumber: params.block.number.toString(),
          blockHash: params.block.hash,
          blockTimestamp: params.block.timestamp.toString(),
          transactionHash: params.block.transactionHash,
          includedAt: sql`NOW()`,
        })
        .where(eq(mutationTable.id, params.mutation.id));
      break;
    case "safe":
      await db
        .update(table)
        .set({ status: params.lifecycle, safeAt: sql`NOW()` })
        .where(eq(mutationTable.id, params.mutation.id));
      break;
    case "finalized":
      await db
        .update(table)
        .set({ status: params.lifecycle, finalizedAt: sql`NOW()` })
        .where(eq(mutationTable.id, params.mutation.id));
      break;
  }
}

async function persistAccount(tx: unknown, account: Hex) {
  const db = txDb(tx);
  await db
    .insert(schema.accounts)
    .values({ id: account })
    .onConflictDoNothing();
}

async function persistNonce(tx: unknown, account: Hex, nonce: bigint) {
  await persistAccount(tx, account);
  const nonceKey = nonce >> 64n;
  const sequence = (nonce & UINT64_MASK) + 1n;
  await txDb(tx)
    .insert(schema.nonces)
    .values({ account, nonceKey: nonceKey.toString(), sequence })
    .onConflictDoUpdate({
      target: [schema.nonces.account, schema.nonces.nonceKey],
      set: { sequence },
    });
}

async function persistKeyValue(
  tx: unknown,
  account: Hex,
  keyIndex: bigint,
  key: { expiry: number; keyType: number; permissions: number; publicKey: Hex },
) {
  await persistAccount(tx, account);
  await txDb(tx)
    .insert(schema.keys)
    .values({ account, keyIndex, ...key })
    .onConflictDoUpdate({
      target: [schema.keys.account, schema.keys.keyIndex],
      set: key,
    });
}

async function nextKeyIndex(tx: unknown, account: Hex): Promise<bigint> {
  const [row] = await txDb(tx)
    .select({
      next: sql<bigint>`coalesce(max(${schema.keys.keyIndex}), -1) + 1`,
    })
    .from(schema.keys)
    .where(eq(schema.keys.account, account));
  return row?.next ?? 0n;
}

async function persistBalanceDelta(
  tx: unknown,
  account: Hex,
  asset: Hex,
  delta: bigint,
) {
  await persistAccount(tx, account);
  await txDb(tx)
    .insert(schema.balances)
    .values({ account, asset, amount: delta.toString() })
    .onConflictDoUpdate({
      target: [schema.balances.account, schema.balances.asset],
      set: { amount: sql`${schema.balances.amount} + ${delta.toString()}` },
    });
}

async function loadInstrumentRow(tx: unknown, instrumentId: number) {
  const [instrument] = await txDb(tx)
    .select()
    .from(schema.instruments)
    .where(eq(schema.instruments.id, BigInt(instrumentId)))
    .limit(1);
  return instrument;
}

async function loadTickVolume(
  tx: unknown,
  instrumentId: number,
  side: 0 | 1,
  price: bigint,
): Promise<number> {
  const [row] = await txDb(tx)
    .select({ volume: schema.ticks.volume })
    .from(schema.ticks)
    .where(
      and(
        eq(schema.ticks.instrumentId, BigInt(instrumentId)),
        eq(schema.ticks.side, side),
        eq(schema.ticks.price, price),
      ),
    )
    .limit(1);
  return row?.volume ?? 0;
}

async function loadOrderRow(tx: unknown, account: Hex, orderIndex: number) {
  const [order] = await txDb(tx)
    .select()
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.account, account),
        eq(schema.orders.orderIndex, BigInt(orderIndex)),
      ),
    )
    .limit(1);
  return order;
}

async function upsertTickDelta(
  tx: unknown,
  instrumentId: number,
  side: 0 | 1,
  price: bigint,
  quantityDelta: bigint,
  remainingDelta: bigint,
) {
  await txDb(tx)
    .insert(schema.ticks)
    .values({
      instrumentId: BigInt(instrumentId),
      side,
      price,
      quantity: quantityDelta,
      remainingQuantity: remainingDelta,
      volume: 0,
    })
    .onConflictDoUpdate({
      target: [
        schema.ticks.instrumentId,
        schema.ticks.side,
        schema.ticks.price,
      ],
      set: {
        quantity: sql`${schema.ticks.quantity} + ${quantityDelta}`,
        remainingQuantity: sql`${schema.ticks.remainingQuantity} + ${remainingDelta}`,
      },
    });
}

async function nextOrderIndex(tx: unknown, account: Hex): Promise<bigint> {
  const [row] = await txDb(tx)
    .select({
      next: sql<bigint>`coalesce(max(${schema.orders.orderIndex}), -1) + 1`,
    })
    .from(schema.orders)
    .where(eq(schema.orders.account, account));
  return row?.next ?? 0n;
}

export function persistedMutations(
  knownPriceLevels: KnownPriceLevels = createKnownPriceLevels(),
): FFCAConfig["mutations"] {
  const mutations = baseMutations(knownPriceLevels);

  mutations.Initialize = {
    ...mutations.Initialize,
    persistMutation: async (tx, { mutation, bundle }) => {
      const args = mutationArgs<InitializeArgs>(mutation);
      await txDb(tx)
        .insert(schema.initializes)
        .values({
          ...baseMutationRow(mutation, bundle),
          accountArg: args.account,
          expiry: args.expiry,
          rootKeyType: args.rootKeyType,
          keyType: args.keyType,
          permissions: args.permissions,
          rootPublicKey: args.rootPublicKey,
          publicKey: args.publicKey,
        });
    },
    persistState: async (tx, { mutation }) => {
      const args = mutationArgs<InitializeArgs>(mutation);
      const signature = mutationSignature(mutation);
      await persistAccount(tx, signature.account);
      await persistKeyValue(tx, signature.account, 0n, {
        expiry: 0,
        keyType: args.rootKeyType,
        permissions: ALL_PERMISSIONS,
        publicKey: args.rootPublicKey,
      });
      await persistKeyValue(tx, signature.account, 1n, {
        expiry: args.expiry,
        keyType: args.keyType,
        permissions: args.permissions,
        publicKey: args.publicKey,
      });
    },
    persistLifecycle: (tx, params) =>
      persistLifecycle(tx, params, schema.initializes),
  };
  mutations.Authorize = {
    ...mutations.Authorize,
    persistMutation: async (tx, { mutation, bundle }) => {
      const args = mutationArgs<AuthorizeArgs>(mutation);
      await txDb(tx)
        .insert(schema.authorizes)
        .values({
          ...baseMutationRow(mutation, bundle),
          expiry: args.expiry,
          keyType: args.keyType,
          permissions: args.permissions,
          publicKey: args.publicKey,
          nonce: args.nonce.toString(),
          deadline: args.deadline.toString(),
        });
    },
    persistState: async (tx, { mutation }) => {
      const args = mutationArgs<AuthorizeArgs>(mutation);
      const signature = mutationSignature(mutation);
      await persistNonce(tx, signature.account, args.nonce);
      await persistKeyValue(
        tx,
        signature.account,
        await nextKeyIndex(tx, signature.account),
        {
          expiry: args.expiry,
          keyType: args.keyType,
          permissions: args.permissions,
          publicKey: args.publicKey,
        },
      );
    },
    persistLifecycle: (tx, params) =>
      persistLifecycle(tx, params, schema.authorizes),
  };
  mutations.Revoke = {
    ...mutations.Revoke,
    persistMutation: async (tx, { mutation, bundle }) => {
      const args = mutationArgs<RevokeArgs>(mutation);
      await txDb(tx)
        .insert(schema.revokes)
        .values({
          ...baseMutationRow(mutation, bundle),
          revokedKeyId: BigInt(args.keyId),
          nonce: args.nonce.toString(),
          deadline: args.deadline.toString(),
        });
    },
    persistState: async (tx, { mutation }) => {
      const args = mutationArgs<RevokeArgs>(mutation);
      const signature = mutationSignature(mutation);
      await persistNonce(tx, signature.account, args.nonce);
      await persistKeyValue(tx, signature.account, BigInt(args.keyId), {
        expiry: 0,
        keyType: 0,
        permissions: 0,
        publicKey: "0x",
      });
    },
    persistLifecycle: (tx, params) =>
      persistLifecycle(tx, params, schema.revokes),
  };
  mutations.CloseOrder = {
    ...mutations.CloseOrder,
    persistMutation: async (tx, { mutation, bundle }) => {
      const args = mutationArgs<CloseOrderArgs>(mutation);
      await txDb(tx)
        .insert(schema.closeOrders)
        .values({
          ...baseMutationRow(mutation, bundle),
          orderId: BigInt(args.orderId),
          nonce: args.nonce.toString(),
          deadline: args.deadline.toString(),
        });
    },
    persistState: async (tx, { mutation }) => {
      const args = mutationArgs<CloseOrderArgs>(mutation);
      const signature = mutationSignature(mutation);
      const order = await loadOrderRow(tx, signature.account, args.orderId);
      await persistNonce(tx, signature.account, args.nonce);
      if (order !== undefined) {
        const orderQuantity = BigInt(order.quantity);
        const orderPrice = BigInt(order.price);
        const orderSide = order.side as 0 | 1;
        const instrument = await loadInstrumentRow(
          tx,
          Number(order.instrumentId),
        );
        if (instrument !== undefined) {
          const [tick] = await txDb(tx)
            .select()
            .from(schema.ticks)
            .where(
              and(
                eq(schema.ticks.instrumentId, order.instrumentId),
                eq(schema.ticks.side, order.side),
                eq(schema.ticks.price, order.price),
              ),
            )
            .limit(1);
          let filledQuantity: bigint;
          let unfilledQuantity: bigint;
          if (tick === undefined || tick.volume > order.tickVolume) {
            filledQuantity = orderQuantity;
            unfilledQuantity = 0n;
          } else {
            const tickQuantity = BigInt(tick.quantity);
            const tickRemainingQuantity = BigInt(tick.remainingQuantity);
            const consumed = tickQuantity - tickRemainingQuantity;
            filledQuantity =
              tickQuantity > 0n
                ? (orderQuantity * consumed) / tickQuantity
                : 0n;
            unfilledQuantity = orderQuantity - filledQuantity;
          }
          await txDb(tx)
            .update(schema.orders)
            .set({ quantity: 0n })
            .where(
              and(
                eq(schema.orders.account, signature.account),
                eq(schema.orders.orderIndex, BigInt(args.orderId)),
              ),
            );
          if (unfilledQuantity > 0n) {
            await upsertTickDelta(
              tx,
              Number(order.instrumentId),
              orderSide,
              orderPrice,
              -unfilledQuantity,
              -unfilledQuantity,
            );
          }
          if (orderSide === 0) {
            await persistBalanceDelta(
              tx,
              signature.account,
              instrument.quote,
              ((unfilledQuantity * orderPrice) >> 32n) <<
                BigInt(instrument.quoteLotExp),
            );
            await persistBalanceDelta(
              tx,
              signature.account,
              instrument.base,
              filledQuantity << BigInt(instrument.baseLotExp),
            );
          } else {
            await persistBalanceDelta(
              tx,
              signature.account,
              instrument.base,
              unfilledQuantity << BigInt(instrument.baseLotExp),
            );
            await persistBalanceDelta(
              tx,
              signature.account,
              instrument.quote,
              ((filledQuantity * orderPrice) >> 32n) <<
                BigInt(instrument.quoteLotExp),
            );
          }
        }
      }
    },
    persistLifecycle: (tx, params) =>
      persistLifecycle(tx, params, schema.closeOrders),
  };
  mutations.ChangeOrder = {
    ...mutations.ChangeOrder,
    persistMutation: async (tx, { mutation, bundle }) => {
      const args = mutationArgs<ChangeOrderArgs>(mutation);
      await txDb(tx)
        .insert(schema.changeOrders)
        .values({
          ...baseMutationRow(mutation, bundle),
          orderId: BigInt(args.orderId),
          price: args.price,
          nonce: args.nonce.toString(),
          deadline: args.deadline.toString(),
        });
    },
    persistState: async (tx, { mutation }) => {
      const args = mutationArgs<ChangeOrderArgs>(mutation);
      const signature = mutationSignature(mutation);
      const order = await loadOrderRow(tx, signature.account, args.orderId);
      const instrument =
        order !== undefined
          ? await loadInstrumentRow(tx, Number(order.instrumentId))
          : undefined;
      await persistNonce(tx, signature.account, args.nonce);
      if (order !== undefined && instrument !== undefined) {
        const orderQuantity = BigInt(order.quantity);
        const orderPrice = BigInt(order.price);
        const orderSide = order.side as 0 | 1;
        await upsertTickDelta(
          tx,
          Number(order.instrumentId),
          orderSide,
          orderPrice,
          -orderQuantity,
          -orderQuantity,
        );
        await txDb(tx)
          .update(schema.orders)
          .set({ quantity: 0n })
          .where(
            and(
              eq(schema.orders.account, signature.account),
              eq(schema.orders.orderIndex, BigInt(args.orderId)),
            ),
          );
        const fullQuantity = orderQuantity << BigInt(instrument.baseLotExp);
        if (orderSide === 0) {
          await persistBalanceDelta(
            tx,
            signature.account,
            instrument.quote,
            ((orderQuantity * orderPrice) >> 32n) <<
              BigInt(instrument.quoteLotExp),
          );
        } else {
          await persistBalanceDelta(
            tx,
            signature.account,
            instrument.base,
            orderQuantity << BigInt(instrument.baseLotExp),
          );
        }
        const tickVolume = await loadTickVolume(
          tx,
          Number(order.instrumentId),
          orderSide,
          args.price,
        );
        await upsertTickDelta(
          tx,
          Number(order.instrumentId),
          orderSide,
          args.price,
          orderQuantity,
          orderQuantity,
        );
        const orderIndex = await nextOrderIndex(tx, signature.account);
        await txDb(tx).insert(schema.orders).values({
          account: signature.account,
          orderIndex,
          quantity: orderQuantity,
          instrumentId: order.instrumentId,
          price: args.price,
          tickVolume,
          side: orderSide,
        });
        if (orderSide === 0) {
          await persistBalanceDelta(
            tx,
            signature.account,
            instrument.quote,
            -(
              ((orderQuantity * args.price) >> 32n) <<
              BigInt(instrument.quoteLotExp)
            ),
          );
        } else {
          await persistBalanceDelta(
            tx,
            signature.account,
            instrument.base,
            -fullQuantity,
          );
        }
      }
    },
    persistLifecycle: (tx, params) =>
      persistLifecycle(tx, params, schema.changeOrders),
  };
  mutations.LimitOrder = {
    ...mutations.LimitOrder,
    persistMutation: async (tx, { mutation, bundle }) => {
      const args = mutationArgs<LimitOrderArgs>(mutation);
      await txDb(tx)
        .insert(schema.limitOrders)
        .values({
          ...baseMutationRow(mutation, bundle),
          quantity: args.quantity.toString(),
          instrumentId: BigInt(args.instrumentId),
          price: args.price,
          bidOrAsk: args.bidOrAsk,
          nonce: args.nonce.toString(),
          deadline: args.deadline.toString(),
        });
    },
    persistState: async (tx, { mutation }) => {
      const args = mutationArgs<LimitOrderArgs>(mutation);
      const signature = mutationSignature(mutation);
      const instrument = await loadInstrumentRow(tx, args.instrumentId);
      if (instrument === undefined) return;
      const quantityLots = toLots(args.quantity, instrument.baseLotExp);
      await persistNonce(tx, signature.account, args.nonce);
      const tickVolume = await loadTickVolume(
        tx,
        args.instrumentId,
        args.bidOrAsk,
        args.price,
      );
      await upsertTickDelta(
        tx,
        args.instrumentId,
        args.bidOrAsk,
        args.price,
        quantityLots,
        quantityLots,
      );
      const orderIndex = await nextOrderIndex(tx, signature.account);
      await txDb(tx)
        .insert(schema.orders)
        .values({
          account: signature.account,
          orderIndex,
          quantity: quantityLots,
          instrumentId: BigInt(args.instrumentId),
          price: args.price,
          tickVolume,
          side: args.bidOrAsk,
        });
      if (args.bidOrAsk === 0) {
        const locked =
          ((quantityLots * args.price) >> 32n) <<
          BigInt(instrument.quoteLotExp);
        await persistBalanceDelta(
          tx,
          signature.account,
          instrument.quote,
          -locked,
        );
      } else {
        const locked = quantityLots << BigInt(instrument.baseLotExp);
        await persistBalanceDelta(
          tx,
          signature.account,
          instrument.base,
          -locked,
        );
      }
    },
    persistLifecycle: (tx, params) =>
      persistLifecycle(tx, params, schema.limitOrders),
  };
  mutations.MarketOrder = {
    ...mutations.MarketOrder,
    persistMutation: async (tx, { mutation, bundle }) => {
      const args = mutationArgs<MarketOrderArgs>(mutation);
      const resolution = mutation.resolution as MarketOrderResolution<bigint>;
      await txDb(tx)
        .insert(schema.marketOrders)
        .values({
          ...baseMutationRow(mutation, bundle),
          quantity: args.quantity.toString(),
          minReceivedQuantity: args.minReceivedQuantity.toString(),
          instrumentId: BigInt(args.instrumentId),
          bidOrAsk: args.bidOrAsk,
          nonce: args.nonce.toString(),
          deadline: args.deadline.toString(),
        });
      if (resolution.fills.length > 0) {
        await txDb(tx)
          .insert(schema.fills)
          .values(
            resolution.fills.map((fill, fillIndex) => ({
              marketOrderId: mutation.id,
              fillIndex,
              quantity: fill.quantity,
              price: fill.price,
            })),
          );
      }
    },
    persistState: async (tx, { mutation }) => {
      const args = mutationArgs<MarketOrderArgs>(mutation);
      const signature = mutationSignature(mutation);
      const resolution = mutation.resolution as MarketOrderResolution<bigint>;
      const instrument = await loadInstrumentRow(tx, args.instrumentId);
      await persistNonce(tx, signature.account, args.nonce);
      if (instrument !== undefined) {
        let baseDelta = 0n;
        let quoteDelta = 0n;
        for (const fill of resolution.fills) {
          const quoteAmount =
            ((fill.quantity * fill.price) >> 32n) <<
            BigInt(instrument.quoteLotExp);
          const baseAmount = fill.quantity << BigInt(instrument.baseLotExp);
          if (args.bidOrAsk === 0) {
            baseDelta += baseAmount;
            quoteDelta -= quoteAmount;
          } else {
            baseDelta -= baseAmount;
            quoteDelta += quoteAmount;
          }
          await txDb(tx)
            .update(schema.ticks)
            .set({
              remainingQuantity: sql`${schema.ticks.remainingQuantity} - ${fill.quantity}`,
              quantity: sql`case when ${schema.ticks.remainingQuantity} - ${fill.quantity} = 0 then 0 else ${schema.ticks.quantity} end`,
              volume: sql`case when ${schema.ticks.remainingQuantity} - ${fill.quantity} = 0 then ${schema.ticks.volume} + 1 else ${schema.ticks.volume} end`,
            })
            .where(
              and(
                eq(schema.ticks.instrumentId, BigInt(args.instrumentId)),
                eq(schema.ticks.side, args.bidOrAsk === 0 ? 1 : 0),
                eq(schema.ticks.price, fill.price),
              ),
            );
        }
        await persistBalanceDelta(
          tx,
          signature.account,
          instrument.base,
          baseDelta,
        );
        await persistBalanceDelta(
          tx,
          signature.account,
          instrument.quote,
          quoteDelta,
        );
      }
    },
    persistLifecycle: (tx, params) =>
      persistLifecycle(tx, params, schema.marketOrders),
  };
  mutations.AddInstrument = {
    ...mutations.AddInstrument,
    persistMutation: async (tx, { mutation, bundle }) => {
      const args = mutationArgs<AddInstrumentArgs>(mutation);
      await txDb(tx)
        .insert(schema.addInstruments)
        .values({
          ...baseMutationRow(mutation, bundle),
          instrumentId: BigInt(args.instrumentId),
          base: args.base,
          quote: args.quote,
          baseLotExp: args.baseLotExp,
          quoteLotExp: args.quoteLotExp,
          nonce: args.nonce.toString(),
          deadline: args.deadline.toString(),
        });
    },
    persistState: async (tx, { mutation }) => {
      const args = mutationArgs<AddInstrumentArgs>(mutation);
      const signature = mutationSignature(mutation);
      await persistNonce(tx, signature.account, args.nonce);
      await txDb(tx)
        .insert(schema.instruments)
        .values({
          id: BigInt(args.instrumentId),
          base: args.base,
          baseLotExp: args.baseLotExp,
          quote: args.quote,
          quoteLotExp: args.quoteLotExp,
        })
        .onConflictDoNothing();
    },
    persistLifecycle: (tx, params) =>
      persistLifecycle(tx, params, schema.addInstruments),
  };
  mutations.Deposit = {
    ...mutations.Deposit,
    persistMutation: async (tx, { mutation, bundle }) => {
      const args = mutationArgs<DepositArgs>(mutation);
      await txDb(tx)
        .insert(schema.deposits)
        .values({
          ...baseMutationRow(mutation, bundle),
          asset: args.asset,
          amount: args.amount.toString(),
          nonce: args.nonce.toString(),
          deadline: args.deadline.toString(),
        });
    },
    persistState: async (tx, { mutation }) => {
      const args = mutationArgs<DepositArgs>(mutation);
      const signature = mutationSignature(mutation);
      await persistNonce(tx, signature.account, args.nonce);
      await persistBalanceDelta(tx, signature.account, args.asset, args.amount);
    },
    persistLifecycle: (tx, params) =>
      persistLifecycle(tx, params, schema.deposits),
  };
  mutations.Withdrawal = {
    ...mutations.Withdrawal,
    persistMutation: async (tx, { mutation, bundle }) => {
      const args = mutationArgs<WithdrawalArgs>(mutation);
      await txDb(tx)
        .insert(schema.withdrawals)
        .values({
          ...baseMutationRow(mutation, bundle),
          asset: args.asset,
          amount: args.amount.toString(),
          nonce: args.nonce.toString(),
          deadline: args.deadline.toString(),
        });
    },
    persistState: async (tx, { mutation }) => {
      const args = mutationArgs<WithdrawalArgs>(mutation);
      const signature = mutationSignature(mutation);
      await persistNonce(tx, signature.account, args.nonce);
      await persistBalanceDelta(
        tx,
        signature.account,
        args.asset,
        -args.amount,
      );
    },
    persistLifecycle: (tx, params) =>
      persistLifecycle(tx, params, schema.withdrawals),
  };

  return mutations;
}
