import { eq } from "drizzle-orm";
import { type FFCAConfig, verifySignature as verifyKeySignature } from "ffca";
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
  type Authorize,
  type CloseOrder,
  type Deposit,
  getNonceSeq,
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
  PERM_ADD_INSTRUMENT,
  PERM_AUTHORIZE,
  PERM_CLOSE_ORDER,
  PERM_DEPOSIT,
  PERM_LIMIT_ORDER,
  PERM_MARKET_ORDER,
  PERM_REVOKE,
  PERM_WITHDRAW,
  type Revoke,
  type State,
  type Withdrawal,
} from "./exchange";
import { resolveMarketOrder } from "./resolution";

type OrderBookState = State<bigint>;
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

  if ((key.permissions & permission) === 0) {
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
        "bytes32 account, uint40 expiry, uint8 keyType, uint8 permissions, bytes publicKey, uint256 nonce, uint256 deadline",
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
      }) =>
        applyLimitOrder(
          state as OrderBookState,
          args as LimitOrderArgs,
          signature as OrderBookSignature,
          digest,
        ),
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
      }) => resolveMarket(state as OrderBookState, args as MarketOrderArgs),
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

async function persistAccount(tx: unknown, account: Hex) {
  const db = txDb(tx);
  await db
    .insert(schema.accounts)
    .values({ id: account })
    .onConflictDoNothing();
}

async function persistKey(
  tx: unknown,
  state: OrderBookState,
  account: Hex,
  keyIndex: number,
) {
  const key = state.accounts[account]?.keys[keyIndex];
  if (key === undefined) return;
  await persistAccount(tx, account);
  await txDb(tx)
    .insert(schema.keys)
    .values({
      account,
      keyIndex: BigInt(keyIndex),
      expiry: key.expiry,
      keyType: key.keyType,
      permissions: key.permissions,
      publicKey: key.publicKey,
    })
    .onConflictDoUpdate({
      target: [schema.keys.account, schema.keys.keyIndex],
      set: {
        expiry: key.expiry,
        keyType: key.keyType,
        permissions: key.permissions,
        publicKey: key.publicKey,
      },
    });
}

async function persistKeys(tx: unknown, state: OrderBookState, account: Hex) {
  const acc = state.accounts[account];
  if (acc === undefined) return;
  for (const keyIndex of acc.keys.keys()) {
    await persistKey(tx, state, account, keyIndex);
  }
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

async function persistBalance(
  tx: unknown,
  state: OrderBookState,
  account: Hex,
  asset: Hex,
) {
  const amount = state.accounts[account]?.balances[asset] ?? 0n;
  await persistAccount(tx, account);
  await txDb(tx)
    .insert(schema.balances)
    .values({ account, asset, amount: amount.toString() })
    .onConflictDoUpdate({
      target: [schema.balances.account, schema.balances.asset],
      set: { amount: amount.toString() },
    });
}

async function persistInstrument(
  tx: unknown,
  state: OrderBookState,
  instrumentId: number,
) {
  const instrument = state.instruments[instrumentId];
  if (instrument === undefined) return;
  await txDb(tx)
    .insert(schema.instruments)
    .values({
      id: BigInt(instrumentId),
      base: instrument.base,
      baseLotExp: instrument.baseLotExp,
      quote: instrument.quote,
      quoteLotExp: instrument.quoteLotExp,
    })
    .onConflictDoUpdate({
      target: schema.instruments.id,
      set: {
        base: instrument.base,
        baseLotExp: instrument.baseLotExp,
        quote: instrument.quote,
        quoteLotExp: instrument.quoteLotExp,
      },
    });
}

async function persistTick(
  tx: unknown,
  state: OrderBookState,
  instrumentId: number,
  side: 0 | 1,
  price: bigint,
) {
  const instrument = state.instruments[instrumentId];
  const tick = (side === 0 ? instrument?.bids : instrument?.asks)?.[
    Number(price)
  ];
  if (tick === undefined) return;
  await persistInstrument(tx, state, instrumentId);
  await txDb(tx)
    .insert(schema.ticks)
    .values({
      instrumentId: BigInt(instrumentId),
      side,
      price,
      quantity: tick.quantity,
      remainingQuantity: tick.remainingQuantity,
      volume: tick.volume,
    })
    .onConflictDoUpdate({
      target: [
        schema.ticks.instrumentId,
        schema.ticks.side,
        schema.ticks.price,
      ],
      set: {
        quantity: tick.quantity,
        remainingQuantity: tick.remainingQuantity,
        volume: tick.volume,
      },
    });
}

async function persistOrder(
  tx: unknown,
  state: OrderBookState,
  account: Hex,
  orderIndex: number,
) {
  const order = state.accounts[account]?.orders[orderIndex];
  if (order === undefined) return;
  await persistAccount(tx, account);
  await persistInstrument(tx, state, order.instrumentId);
  await txDb(tx)
    .insert(schema.orders)
    .values({
      account,
      orderIndex: BigInt(orderIndex),
      quantity: order.quantity,
      instrumentId: BigInt(order.instrumentId),
      price: order.price,
      tickVolume: order.tickVolume,
      side: order.side,
    })
    .onConflictDoUpdate({
      target: [schema.orders.account, schema.orders.orderIndex],
      set: {
        quantity: order.quantity,
        instrumentId: BigInt(order.instrumentId),
        price: order.price,
        tickVolume: order.tickVolume,
        side: order.side,
      },
    });
}

async function persistOrders(tx: unknown, state: OrderBookState, account: Hex) {
  const acc = state.accounts[account];
  if (acc === undefined) return;
  for (const orderIndex of acc.orders.keys()) {
    await persistOrder(tx, state, account, orderIndex);
  }
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
    persistState: async (tx, { mutation }) => {
      const signature = mutationSignature(mutation);
      await persistAccount(tx, signature.account);
      await persistKeys(tx, state, signature.account);
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
      await persistKeys(tx, state, signature.account);
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
      await persistKey(tx, state, signature.account, args.keyId);
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
      const order = state.accounts[signature.account]?.orders[args.orderId];
      await persistNonce(tx, signature.account, args.nonce);
      await persistOrder(tx, state, signature.account, args.orderId);
      if (order !== undefined) {
        const instrument = state.instruments[order.instrumentId];
        if (instrument !== undefined) {
          await persistBalance(tx, state, signature.account, instrument.base);
          await persistBalance(tx, state, signature.account, instrument.quote);
          await persistTick(
            tx,
            state,
            order.instrumentId,
            order.side,
            order.price,
          );
        }
      }
    },
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
    persistState: async (tx, { mutation }) => {
      const args = mutationArgs<LimitOrderArgs>(mutation);
      const signature = mutationSignature(mutation);
      const instrument = state.instruments[args.instrumentId];
      await persistNonce(tx, signature.account, args.nonce);
      await persistOrders(tx, state, signature.account);
      await persistTick(
        tx,
        state,
        args.instrumentId,
        args.bidOrAsk,
        args.price,
      );
      if (instrument !== undefined) {
        await persistBalance(
          tx,
          state,
          signature.account,
          args.bidOrAsk === 0 ? instrument.quote : instrument.base,
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
      const instrument = state.instruments[args.instrumentId];
      await persistNonce(tx, signature.account, args.nonce);
      if (instrument !== undefined) {
        await persistBalance(tx, state, signature.account, instrument.base);
        await persistBalance(tx, state, signature.account, instrument.quote);
        for (const fill of resolution.fills) {
          await persistTick(
            tx,
            state,
            args.instrumentId,
            args.bidOrAsk === 0 ? 1 : 0,
            fill.price,
          );
        }
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
      await persistInstrument(tx, state, args.instrumentId);
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
      await persistBalance(tx, state, signature.account, args.asset);
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
      await persistBalance(tx, state, signature.account, args.asset);
    },
    persistLifecycle: (tx, params) =>
      persistLifecycle(tx, params, schema.withdrawals),
  };

  return mutations;
}
