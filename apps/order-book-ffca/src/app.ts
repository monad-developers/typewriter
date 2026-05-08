import { eq } from "drizzle-orm";
import type { FFCAConfig } from "ffca";
import {
  encodeAbiParameters,
  type Hex,
  parseAbiParameters,
  parseSignature,
} from "viem";
import * as schema from "./app-schema";
import {
  type AddInstrument,
  type Authorize,
  type CloseOrder,
  type Deposit,
  getAccount,
  handleAddInstrument,
  handleAuthorize,
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
  type Revoke,
  type State,
  type Withdrawal,
} from "./exchange";
import { resolveMarketOrder } from "./resolution";

type OrderBookState = State<bigint>;

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
  "LimitOrder",
  "MarketOrder",
  "AddInstrument",
  "Deposit",
  "Withdrawal",
] as const;

function bumpNonce(
  state: OrderBookState,
  signature: OrderBookSignature,
  args: SignedArgs,
): void {
  incrementNonce(getAccount(state, signature.account), args.nonce >> 64n);
}

function applyInitialize(
  state: OrderBookState,
  args: InitializeArgs,
  signature: OrderBookSignature,
): void {
  handleInitialize(state, args, signature.account);
}

function applyAuthorize(
  state: OrderBookState,
  args: AuthorizeArgs,
  signature: OrderBookSignature,
): void {
  handleAuthorize(state, args, signature.account);
  bumpNonce(state, signature, args);
}

function applyRevoke(
  state: OrderBookState,
  args: RevokeArgs,
  signature: OrderBookSignature,
): void {
  handleRevoke(state, args, signature.account);
  bumpNonce(state, signature, args);
}

function applyCloseOrder(
  state: OrderBookState,
  args: CloseOrderArgs,
  signature: OrderBookSignature,
): void {
  handleCloseOrder(state, args, signature.account);
  bumpNonce(state, signature, args);
}

function applyLimitOrder(
  state: OrderBookState,
  args: LimitOrderArgs,
  signature: OrderBookSignature,
): void {
  handleLimitOrder(state, args, signature.account);
  bumpNonce(state, signature, args);
}

function applyMarketOrder(
  state: OrderBookState,
  args: MarketOrderArgs,
  resolution: MarketOrderResolution<bigint>,
  signature: OrderBookSignature,
): void {
  handleMarketOrder(state, args, resolution, signature.account);
  bumpNonce(state, signature, args);
}

function applyAddInstrument(
  state: OrderBookState,
  args: AddInstrumentArgs,
  signature: OrderBookSignature,
): void {
  handleAddInstrument(state, args);
  bumpNonce(state, signature, args);
}

function applyDeposit(
  state: OrderBookState,
  args: DepositArgs,
  signature: OrderBookSignature,
): void {
  handleDeposit(state, args, signature.account);
  bumpNonce(state, signature, args);
}

function applyWithdrawal(
  state: OrderBookState,
  args: WithdrawalArgs,
  signature: OrderBookSignature,
): void {
  handleWithdrawal(state, args, signature.account);
  bumpNonce(state, signature, args);
}

function resolveMarket(
  state: OrderBookState,
  args: MarketOrderArgs,
): MarketOrderResolution<bigint> {
  const instrument = state.instruments[args.instrumentId];
  if (instrument === undefined) return { fills: [] };
  return resolveMarketOrder(instrument, args, new Map());
}

export function baseMutations(): FFCAConfig["mutations"] {
  return {
    Initialize: {
      tag: MutationType.Initialize,
      table: schema.initializes,
      params: parseAbiParameters(
        "bytes32 account, uint40 expiry, uint8 rootKeyType, uint8 keyType, uint8 permissions, bytes rootPublicKey, bytes publicKey",
      ),
      apply: ((state: unknown, args: unknown, signature: unknown) =>
        applyInitialize(
          state as OrderBookState,
          args as InitializeArgs,
          signature as OrderBookSignature,
        )) as (state: unknown, args: unknown, signature: unknown) => void,
    },
    Authorize: {
      tag: MutationType.Authorize,
      table: schema.authorizes,
      params: parseAbiParameters(
        "bytes32 account, uint40 expiry, uint8 keyType, uint8 permissions, bytes publicKey, uint256 nonce, uint256 deadline",
      ),
      apply: ((state: unknown, args: unknown, signature: unknown) =>
        applyAuthorize(
          state as OrderBookState,
          args as AuthorizeArgs,
          signature as OrderBookSignature,
        )) as (state: unknown, args: unknown, signature: unknown) => void,
    },
    Revoke: {
      tag: MutationType.Revoke,
      table: schema.revokes,
      params: parseAbiParameters(
        "bytes32 account, uint64 keyId, uint256 nonce, uint256 deadline",
      ),
      apply: ((state: unknown, args: unknown, signature: unknown) =>
        applyRevoke(
          state as OrderBookState,
          args as RevokeArgs,
          signature as OrderBookSignature,
        )) as (state: unknown, args: unknown, signature: unknown) => void,
    },
    CloseOrder: {
      tag: MutationType.CloseOrder,
      table: schema.closeOrders,
      params: parseAbiParameters(
        "uint64 orderId, uint256 nonce, uint256 deadline",
      ),
      apply: ((state: unknown, args: unknown, signature: unknown) =>
        applyCloseOrder(
          state as OrderBookState,
          args as CloseOrderArgs,
          signature as OrderBookSignature,
        )) as (state: unknown, args: unknown, signature: unknown) => void,
    },
    LimitOrder: {
      tag: MutationType.LimitOrder,
      table: schema.limitOrders,
      params: parseAbiParameters(
        "uint256 quantity, uint64 instrumentId, uint64 price, uint8 bidOrAsk, uint256 nonce, uint256 deadline",
      ),
      apply: ((state: unknown, args: unknown, signature: unknown) =>
        applyLimitOrder(
          state as OrderBookState,
          args as LimitOrderArgs,
          signature as OrderBookSignature,
        )) as (state: unknown, args: unknown, signature: unknown) => void,
    },
    MarketOrder: {
      tag: MutationType.MarketOrder,
      table: schema.marketOrders,
      params: parseAbiParameters(
        "uint256 quantity, uint256 minReceivedQuantity, uint64 instrumentId, uint8 bidOrAsk, uint256 nonce, uint256 deadline",
      ),
      resolution: parseAbiParameters("(uint64 quantity, uint64 price)[] fills"),
      resolve: ((state: unknown, args: unknown) =>
        resolveMarket(state as OrderBookState, args as MarketOrderArgs)) as (
        state: unknown,
        args: unknown,
      ) => unknown,
      apply: ((
        state: unknown,
        args: unknown,
        resolution: unknown,
        signature: unknown,
      ) =>
        applyMarketOrder(
          state as OrderBookState,
          args as MarketOrderArgs,
          resolution as MarketOrderResolution<bigint>,
          signature as OrderBookSignature,
        )) as (
        state: unknown,
        args: unknown,
        resolution: unknown,
        signature: unknown,
      ) => void,
    },
    AddInstrument: {
      tag: MutationType.AddInstrument,
      table: schema.addInstruments,
      params: parseAbiParameters(
        "uint64 instrumentId, address base, address quote, uint8 baseLotExp, uint8 quoteLotExp, uint256 nonce, uint256 deadline",
      ),
      apply: ((state: unknown, args: unknown, signature: unknown) =>
        applyAddInstrument(
          state as OrderBookState,
          args as AddInstrumentArgs,
          signature as OrderBookSignature,
        )) as (state: unknown, args: unknown, signature: unknown) => void,
    },
    Deposit: {
      tag: MutationType.Deposit,
      table: schema.deposits,
      params: parseAbiParameters(
        "address asset, uint256 amount, uint256 nonce, uint256 deadline",
      ),
      apply: ((state: unknown, args: unknown, signature: unknown) =>
        applyDeposit(
          state as OrderBookState,
          args as DepositArgs,
          signature as OrderBookSignature,
        )) as (state: unknown, args: unknown, signature: unknown) => void,
    },
    Withdrawal: {
      tag: MutationType.Withdrawal,
      table: schema.withdrawals,
      params: parseAbiParameters(
        "address asset, uint256 amount, uint256 nonce, uint256 deadline",
      ),
      apply: ((state: unknown, args: unknown, signature: unknown) =>
        applyWithdrawal(
          state as OrderBookState,
          args as WithdrawalArgs,
          signature as OrderBookSignature,
        )) as (state: unknown, args: unknown, signature: unknown) => void,
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
    case "proposed":
      await db
        .update(table)
        .set({
          status: params.lifecycle,
          blockNumber: params.block.number.toString(),
          blockHash: params.block.hash,
          blockTimestamp: params.block.timestamp.toString(),
          transactionHash: params.block.transactionHash,
        })
        .where(eq(mutationTable.id, params.mutation.id));
      break;
    case "voted":
    case "finalized":
    case "verified":
      await db
        .update(table)
        .set({ status: params.lifecycle })
        .where(eq(mutationTable.id, params.mutation.id));
      break;
  }
}

async function persistWholeState(tx: unknown, state: OrderBookState) {
  const db = txDb(tx);
  await db.delete(schema.orders);
  await db.delete(schema.ticks);
  await db.delete(schema.balances);
  await db.delete(schema.nonces);
  await db.delete(schema.keys);
  await db.delete(schema.accounts);
  await db.delete(schema.instruments);

  const instrumentRows: (typeof schema.instruments.$inferInsert)[] = [];
  const tickRows: (typeof schema.ticks.$inferInsert)[] = [];
  for (const [id, instrument] of Object.entries(state.instruments)) {
    instrumentRows.push({
      id: BigInt(id),
      base: instrument.base,
      baseLotExp: instrument.baseLotExp,
      quote: instrument.quote,
      quoteLotExp: instrument.quoteLotExp,
    });
    for (const [side, ticks] of [
      [0, instrument.bids],
      [1, instrument.asks],
    ] as const) {
      for (const [price, tick] of Object.entries(ticks)) {
        tickRows.push({
          instrumentId: BigInt(id),
          side,
          price: BigInt(price),
          quantity: tick.quantity,
          remainingQuantity: tick.remainingQuantity,
          volume: tick.volume,
        });
      }
    }
  }

  if (instrumentRows.length > 0)
    await db.insert(schema.instruments).values(instrumentRows);
  if (tickRows.length > 0) await db.insert(schema.ticks).values(tickRows);

  const accountRows: (typeof schema.accounts.$inferInsert)[] = [];
  const keyRows: (typeof schema.keys.$inferInsert)[] = [];
  const nonceRows: (typeof schema.nonces.$inferInsert)[] = [];
  const balanceRows: (typeof schema.balances.$inferInsert)[] = [];
  const orderRows: (typeof schema.orders.$inferInsert)[] = [];

  for (const [account, acc] of Object.entries(state.accounts)) {
    accountRows.push({ id: account });
    for (const [keyIndex, key] of acc.keys.entries()) {
      keyRows.push({
        account,
        keyIndex: BigInt(keyIndex),
        expiry: key.expiry,
        keyType: key.keyType,
        permissions: key.permissions,
        publicKey: key.publicKey,
      });
    }
    for (const [nonceKey, sequence] of Object.entries(acc.nonces)) {
      nonceRows.push({ account, nonceKey, sequence });
    }
    for (const [asset, amount] of Object.entries(acc.balances)) {
      balanceRows.push({ account, asset, amount: amount.toString() });
    }
    for (const [orderIndex, order] of acc.orders.entries()) {
      orderRows.push({
        account,
        orderIndex: BigInt(orderIndex),
        quantity: order.quantity,
        instrumentId: BigInt(order.instrumentId),
        price: order.price,
        tickVolume: order.tickVolume,
        side: order.side,
      });
    }
  }

  if (accountRows.length > 0)
    await db.insert(schema.accounts).values(accountRows);
  if (keyRows.length > 0) await db.insert(schema.keys).values(keyRows);
  if (nonceRows.length > 0) await db.insert(schema.nonces).values(nonceRows);
  if (balanceRows.length > 0)
    await db.insert(schema.balances).values(balanceRows);
  if (orderRows.length > 0) await db.insert(schema.orders).values(orderRows);
}

export function persistedMutations(
  state: OrderBookState,
): FFCAConfig["mutations"] {
  const mutations = baseMutations();

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
    persistState: (tx) => persistWholeState(tx, state),
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
    persistState: (tx) => persistWholeState(tx, state),
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
    persistState: (tx) => persistWholeState(tx, state),
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
    persistState: (tx) => persistWholeState(tx, state),
    persistLifecycle: (tx, params) =>
      persistLifecycle(tx, params, schema.closeOrders),
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
    persistState: (tx) => persistWholeState(tx, state),
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
    persistState: (tx) => persistWholeState(tx, state),
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
    persistState: (tx) => persistWholeState(tx, state),
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
    persistState: (tx) => persistWholeState(tx, state),
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
    persistState: (tx) => persistWholeState(tx, state),
    persistLifecycle: (tx, params) =>
      persistLifecycle(tx, params, schema.withdrawals),
  };

  return mutations;
}
