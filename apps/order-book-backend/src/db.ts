import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { Address, Hex } from "viem";
import * as schema from "./app-schema";
import type {
  KeyType,
  ResolvedMutation,
  Side,
  State,
  TaggedMutation,
} from "./exchange";
import {
  createState,
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
  incrementNonce,
  MutationType,
} from "./exchange";

type DB = BunSQLDatabase<typeof schema>;
type BundleDBStatus = (typeof schema.bundleStatusEnum.enumValues)[number];
type BlockRow = { number: bigint; hash: Hex; timestamp: bigint };
type AcceptedMutation = ResolvedMutation & { id: number };

const MUTATION_TYPE_TO_ENUM: Record<
  MutationType,
  (typeof schema.mutationEnum.enumValues)[number]
> = {
  [MutationType.Initialize]: "initialize",
  [MutationType.Authorize]: "authorize",
  [MutationType.Revoke]: "revoke",
  [MutationType.CloseOrder]: "closeOrder",
  [MutationType.LimitOrder]: "limitOrder",
  [MutationType.MarketOrder]: "marketOrder",
  [MutationType.AddInstrument]: "addInstrument",
  [MutationType.Deposit]: "deposit",
  [MutationType.Withdrawal]: "withdrawal",
};

export async function loadState(db: DB): Promise<State<bigint>> {
  const state: State<bigint> = { accounts: {}, instruments: {} };

  const allAccounts = await db.select().from(schema.accounts);
  for (const row of allAccounts) {
    state.accounts[row.id as Hex] = {
      nonces: {},
      balances: {},
      keys: [],
      orders: [],
    };
  }

  const allKeys = await db
    .select()
    .from(schema.keys)
    .orderBy(asc(schema.keys.keyIndex));
  for (const row of allKeys) {
    const acc = state.accounts[row.account as Hex];
    if (!acc) continue;
    while (acc.keys.length < Number(row.keyIndex)) {
      acc.keys.push({ expiry: 0, keyType: 0, permissions: 0, publicKey: "0x" });
    }
    acc.keys.push({
      expiry: row.expiry,
      keyType: row.keyType as KeyType,
      permissions: row.permissions,
      publicKey: row.publicKey as Hex,
    });
  }

  const allNonces = await db.select().from(schema.nonces);
  for (const row of allNonces) {
    const acc = state.accounts[row.account as Hex];
    if (!acc) continue;
    acc.nonces[row.nonceKey!] = row.sequence;
  }

  const allBalances = await db.select().from(schema.balances);
  for (const row of allBalances) {
    const acc = state.accounts[row.account as Hex];
    if (!acc) continue;
    acc.balances[row.asset as Address] = BigInt(row.amount!);
  }

  const allOrders = await db
    .select()
    .from(schema.orders)
    .orderBy(asc(schema.orders.orderIndex));
  for (const row of allOrders) {
    const acc = state.accounts[row.account as Hex];
    if (!acc) continue;
    while (acc.orders.length < Number(row.orderIndex)) {
      acc.orders.push({
        quantity: 0n,
        instrumentId: 0,
        price: 0n,
        tickVolume: 0,
        side: 0,
      });
    }
    acc.orders.push({
      quantity: row.quantity,
      instrumentId: Number(row.instrumentId),
      price: row.price,
      tickVolume: row.tickVolume,
      side: row.side as Side,
    });
  }

  const allInstruments = await db.select().from(schema.instruments);
  for (const row of allInstruments) {
    state.instruments[Number(row.id)] = {
      base: row.base as Address,
      baseLotExp: row.baseLotExp,
      quote: row.quote as Address,
      quoteLotExp: row.quoteLotExp,
      bids: {},
      asks: {},
    };
  }

  const allTicks = await db.select().from(schema.ticks);
  for (const row of allTicks) {
    const instrument = state.instruments[Number(row.instrumentId)];
    if (!instrument) continue;
    const ticks = row.side === 0 ? instrument.bids : instrument.asks;
    ticks[Number(row.price)] = {
      quantity: row.quantity,
      remainingQuantity: row.remainingQuantity,
      volume: row.volume,
    };
  }

  return state;
}

export async function loadMaxMutationId(db: DB): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${schema.mutations.id}), 0)` })
    .from(schema.mutations);
  return row!.max + 1;
}

export async function checkConsistency(db: DB): Promise<boolean> {
  const [row] = await db
    .select({
      exists: sql<boolean>`exists(select 1 from ${schema.bundles} where ${schema.bundles.status} = 'accepted')`,
    })
    .from(schema.bundles);
  return !row?.exists;
}

async function loadAllMutations(
  db: DB,
): Promise<(ResolvedMutation & { bundleId: number; id: number })[]> {
  const centrals = await db
    .select()
    .from(schema.mutations)
    .orderBy(
      asc(schema.mutations.bundleId),
      asc(schema.mutations.bundlePosition),
    );

  const [
    initRows,
    authRows,
    revokeRows,
    closeRows,
    limitRows,
    marketRows,
    addInstRows,
    depRows,
    wdRows,
    fillRows,
  ] = await Promise.all([
    db.select().from(schema.initializes),
    db.select().from(schema.authorizes),
    db.select().from(schema.revokes),
    db.select().from(schema.closeOrders),
    db.select().from(schema.limitOrders),
    db.select().from(schema.marketOrders),
    db.select().from(schema.addInstruments),
    db.select().from(schema.deposits),
    db.select().from(schema.withdrawals),
    db
      .select()
      .from(schema.fills)
      .orderBy(asc(schema.fills.marketOrderId), asc(schema.fills.fillIndex)),
  ]);

  const initById = new Map(initRows.map((r) => [r.id, r]));
  const authById = new Map(authRows.map((r) => [r.id, r]));
  const revokeById = new Map(revokeRows.map((r) => [r.id, r]));
  const closeById = new Map(closeRows.map((r) => [r.id, r]));
  const limitById = new Map(limitRows.map((r) => [r.id, r]));
  const marketById = new Map(marketRows.map((r) => [r.id, r]));
  const addInstById = new Map(addInstRows.map((r) => [r.id, r]));
  const depById = new Map(depRows.map((r) => [r.id, r]));
  const wdById = new Map(wdRows.map((r) => [r.id, r]));
  const fillsByMarket = new Map<number, typeof fillRows>();
  for (const f of fillRows) {
    const list = fillsByMarket.get(f.marketOrderId) ?? [];
    list.push(f);
    fillsByMarket.set(f.marketOrderId, list);
  }

  const out: (ResolvedMutation & { bundleId: number; id: number })[] = [];
  for (const c of centrals) {
    if (c.bundleId == null) continue;
    const signed = {
      account: c.account as Hex,
      keyId: c.keyIndex != null ? Number(c.keyIndex) : 0,
      nonce: c.nonce != null ? BigInt(c.nonce) : 0n,
      deadline: BigInt(c.deadline),
      rawSignature: c.rawSignature as Hex,
    };
    const shared = { id: c.id, bundleId: c.bundleId };

    switch (c.type) {
      case "initialize": {
        const p = initById.get(c.id)!;
        out.push({
          ...shared,
          type: MutationType.Initialize,
          ...signed,
          mutation: {
            expiry: p.expiry,
            rootKeyType: p.rootKeyType,
            keyType: p.keyType,
            permissions: p.permissions,
            rootPublicKey: p.rootPublicKey as Hex,
            publicKey: p.publicKey as Hex,
          },
        });
        break;
      }
      case "authorize": {
        const p = authById.get(c.id)!;
        out.push({
          ...shared,
          type: MutationType.Authorize,
          ...signed,
          mutation: {
            expiry: p.expiry,
            keyType: p.keyType,
            permissions: p.permissions,
            publicKey: p.publicKey as Hex,
          },
        });
        break;
      }
      case "revoke": {
        const p = revokeById.get(c.id)!;
        out.push({
          ...shared,
          type: MutationType.Revoke,
          ...signed,
          mutation: { keyId: Number(p.revokedKeyId) },
        });
        break;
      }
      case "closeOrder": {
        const p = closeById.get(c.id)!;
        out.push({
          ...shared,
          type: MutationType.CloseOrder,
          ...signed,
          mutation: { orderId: Number(p.orderId) },
        });
        break;
      }
      case "limitOrder": {
        const p = limitById.get(c.id)!;
        out.push({
          ...shared,
          type: MutationType.LimitOrder,
          ...signed,
          mutation: {
            quantity: BigInt(p.quantity),
            instrumentId: Number(p.instrumentId),
            price: p.price,
            bidOrAsk: p.bidOrAsk as Side,
          },
        });
        break;
      }
      case "marketOrder": {
        const p = marketById.get(c.id)!;
        const fills = fillsByMarket.get(c.id) ?? [];
        out.push({
          ...shared,
          type: MutationType.MarketOrder,
          ...signed,
          mutation: {
            quantity: BigInt(p.quantity),
            minReceivedQuantity: BigInt(p.minReceivedQuantity),
            instrumentId: Number(p.instrumentId),
            bidOrAsk: p.bidOrAsk as Side,
          },
          resolution: {
            fills: fills.map((f) => ({ quantity: f.quantity, price: f.price })),
          },
        });
        break;
      }
      case "addInstrument": {
        const p = addInstById.get(c.id)!;
        out.push({
          ...shared,
          type: MutationType.AddInstrument,
          ...signed,
          mutation: {
            instrumentId: Number(p.instrumentId),
            base: p.base as Address,
            quote: p.quote as Address,
            baseLotExp: p.baseLotExp,
            quoteLotExp: p.quoteLotExp,
          },
        });
        break;
      }
      case "deposit": {
        const p = depById.get(c.id)!;
        out.push({
          ...shared,
          type: MutationType.Deposit,
          ...signed,
          mutation: { asset: p.asset as Address, amount: BigInt(p.amount!) },
        });
        break;
      }
      case "withdrawal": {
        const p = wdById.get(c.id)!;
        out.push({
          ...shared,
          type: MutationType.Withdrawal,
          ...signed,
          mutation: { asset: p.asset as Address, amount: BigInt(p.amount!) },
        });
        break;
      }
    }
  }

  return out;
}

function replayMutation(state: State<bigint>, m: ResolvedMutation): void {
  switch (m.type) {
    case MutationType.Initialize:
      handleInitialize(state, m.mutation, m.account);
      break;
    case MutationType.Authorize:
      handleAuthorize(state, m.mutation, m.account);
      break;
    case MutationType.Revoke:
      handleRevoke(state, m.mutation, m.account);
      break;
    case MutationType.CloseOrder:
      handleCloseOrder(state, m.mutation, m.account);
      break;
    case MutationType.LimitOrder:
      handleLimitOrder(state, m.mutation, m.account);
      break;
    case MutationType.MarketOrder:
      handleMarketOrder(state, m.mutation, m.resolution, m.account);
      break;
    case MutationType.AddInstrument:
      handleAddInstrument(state, m.mutation);
      break;
    case MutationType.Deposit:
      handleDeposit(state, m.mutation, m.account);
      break;
    case MutationType.Withdrawal:
      handleWithdrawal(state, m.mutation, m.account);
      break;
  }

  if (m.type !== MutationType.Initialize) {
    const nonceKey = m.nonce >> 64n;
    incrementNonce(getAccount(state, m.account), nonceKey);
  }
}

async function persistState(db: DB, state: State<bigint>) {
  for (const [instId, inst] of Object.entries(state.instruments)) {
    await db.insert(schema.instruments).values({
      id: BigInt(Number(instId)),
      base: inst.base,
      baseLotExp: inst.baseLotExp,
      quote: inst.quote,
      quoteLotExp: inst.quoteLotExp,
    });

    for (const [side, ticks] of [
      [0, inst.bids],
      [1, inst.asks],
    ] as const) {
      for (const [price, tick] of Object.entries(ticks)) {
        await db.insert(schema.ticks).values({
          instrumentId: BigInt(Number(instId)),
          side,
          price: BigInt(Number(price)),
          quantity: tick.quantity,
          remainingQuantity: tick.remainingQuantity,
          volume: tick.volume,
        });
      }
    }
  }

  for (const [accountId, acc] of Object.entries(state.accounts)) {
    await db.insert(schema.accounts).values({ id: accountId });

    for (let i = 0; i < acc.keys.length; i++) {
      const key = acc.keys[i]!;
      await db.insert(schema.keys).values({
        account: accountId,
        keyIndex: BigInt(i),
        expiry: key.expiry,
        keyType: key.keyType,
        permissions: key.permissions,
        publicKey: key.publicKey,
      });
    }

    for (const [nonceKey, sequence] of Object.entries(acc.nonces)) {
      await db
        .insert(schema.nonces)
        .values({ account: accountId, nonceKey, sequence });
    }

    for (const [asset, amount] of Object.entries(acc.balances)) {
      await db
        .insert(schema.balances)
        .values({ account: accountId, asset, amount: amount.toString() });
    }

    for (let i = 0; i < acc.orders.length; i++) {
      const order = acc.orders[i]!;
      await db.insert(schema.orders).values({
        account: accountId,
        orderIndex: BigInt(i),
        quantity: order.quantity,
        instrumentId: BigInt(order.instrumentId),
        price: order.price,
        tickVolume: order.tickVolume,
        side: order.side,
      });
    }
  }
}

export async function recoverState(
  db: DB,
  consistent: boolean,
): Promise<{ state: State<bigint>; mutationId: number }> {
  await db
    .delete(schema.mutations)
    .where(eq(schema.mutations.status, "pending"));

  if (consistent) {
    const state = await loadState(db);
    const mutationId = await loadMaxMutationId(db);
    return { state, mutationId };
  }

  return db.transaction(async (tx) => {
    // biome-ignore lint: transaction has same query API as DB
    const d: any = tx;

    const acceptedRows = await d
      .select({ id: schema.mutations.id })
      .from(schema.mutations)
      .where(eq(schema.mutations.status, "accepted"));
    const acceptedIds = acceptedRows.map((r: { id: number }) => r.id);

    if (acceptedIds.length > 0) {
      await d
        .delete(schema.fills)
        .where(inArray(schema.fills.marketOrderId, acceptedIds));
      for (const table of [
        schema.initializes,
        schema.authorizes,
        schema.revokes,
        schema.closeOrders,
        schema.limitOrders,
        schema.marketOrders,
        schema.addInstruments,
        schema.deposits,
        schema.withdrawals,
      ] as const) {
        await d.delete(table).where(inArray(table.id, acceptedIds));
      }
      await d
        .delete(schema.mutations)
        .where(inArray(schema.mutations.id, acceptedIds));
    }
    await d.delete(schema.bundles).where(eq(schema.bundles.status, "accepted"));

    await d.delete(schema.ticks);
    await d.delete(schema.orders);
    await d.delete(schema.balances);
    await d.delete(schema.nonces);
    await d.delete(schema.keys);
    await d.delete(schema.accounts);
    await d.delete(schema.instruments);

    const mutations = await loadAllMutations(d);

    const state = createState();
    for (const m of mutations) {
      try {
        replayMutation(state, m);
      } catch (err) {
        throw new Error(
          `replayMutation failed: bundleId=${m.bundleId} type=${MutationType[m.type]} nonce=${"nonce" in m ? m.nonce : "n/a"}: ${err instanceof Error ? err.message : err}`,
          { cause: err },
        );
      }
    }

    await persistState(d, state);

    const mutationId = await loadMaxMutationId(d);
    return { state, mutationId };
  });
}

export async function insertBlock(db: DB, block: BlockRow) {
  await db
    .insert(schema.blocks)
    .values({
      number: block.number.toString(),
      hash: block.hash,
      timestamp: block.timestamp.toString(),
    })
    .onConflictDoNothing();
}

export async function insertBundle(db: DB): Promise<number> {
  const [row] = await db
    .insert(schema.bundles)
    .values({ acceptedAt: sql`NOW()` })
    .returning({ id: schema.bundles.id });
  return row!.id;
}

const BUNDLE_STATUS_TIMESTAMP_COL: Record<
  BundleDBStatus,
  keyof typeof schema.bundles.$inferInsert
> = {
  accepted: "acceptedAt",
  proposed: "proposedAt",
  voted: "votedAt",
  finalized: "finalizedAt",
  verified: "verifiedAt",
};

export async function updateBundleStatus(
  db: DB,
  bundleId: number,
  status: BundleDBStatus,
) {
  await db
    .update(schema.bundles)
    .set({
      status: status as BundleDBStatus,
      [BUNDLE_STATUS_TIMESTAMP_COL[status]]: sql`NOW()`,
    })
    .where(eq(schema.bundles.id, bundleId));
}

export async function updateBundleBlock(
  db: DB,
  bundleId: number,
  blockNumber: bigint,
  transactionHash: Hex,
) {
  await db
    .update(schema.bundles)
    .set({ blockNumber: blockNumber.toString(), transactionHash })
    .where(eq(schema.bundles.id, bundleId));
}

export async function updateBundleMutationStatuses(
  db: DB,
  bundleId: number,
  status: BundleDBStatus,
) {
  await db
    .update(schema.mutations)
    .set({
      status: status as BundleDBStatus,
      [BUNDLE_STATUS_TIMESTAMP_COL[status]]: sql`NOW()`,
    })
    .where(eq(schema.mutations.bundleId, bundleId));
}

export async function updateBundleMutationsBlock(
  db: DB,
  bundleId: number,
  blockNumber: bigint,
) {
  await db
    .update(schema.mutations)
    .set({ blockNumber: blockNumber.toString() })
    .where(eq(schema.mutations.bundleId, bundleId));
}

async function syncNonce(
  db: DB,
  state: State<bigint>,
  account: Hex,
  nonce: bigint,
) {
  const acc = state.accounts[account];
  if (!acc) return;
  const nonceKey = nonce >> 64n;
  const sequence = acc.nonces[nonceKey.toString()] ?? 0n;
  await db
    .insert(schema.nonces)
    .values({
      account,
      nonceKey: nonceKey.toString(),
      sequence,
    })
    .onConflictDoUpdate({
      target: [schema.nonces.account, schema.nonces.nonceKey],
      set: { sequence },
    });
}

export async function syncState(
  db: DB,
  state: State<bigint>,
  m: AcceptedMutation,
) {
  switch (m.type) {
    case MutationType.Initialize: {
      const acc = state.accounts[m.account];
      if (!acc) break;

      await db
        .insert(schema.accounts)
        .values({ id: m.account })
        .onConflictDoNothing();

      for (let i = 0; i < acc.keys.length; i++) {
        const key = acc.keys[i]!;
        await db
          .insert(schema.keys)
          .values({
            account: m.account,
            keyIndex: BigInt(i),
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

      await syncNonce(db, state, m.account, m.nonce);
      break;
    }

    case MutationType.Authorize: {
      const acc = state.accounts[m.account];
      if (!acc) break;

      const keyIndex = acc.keys.length - 1;
      const key = acc.keys[keyIndex]!;
      await db
        .insert(schema.keys)
        .values({
          account: m.account,
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

      await syncNonce(db, state, m.account, m.nonce);
      break;
    }

    case MutationType.Revoke: {
      const acc = state.accounts[m.account];
      if (!acc) break;

      const key = acc.keys[m.mutation.keyId]!;
      await db
        .insert(schema.keys)
        .values({
          account: m.account,
          keyIndex: BigInt(m.mutation.keyId),
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

      await syncNonce(db, state, m.account, m.nonce);
      break;
    }

    case MutationType.Deposit:
    case MutationType.Withdrawal: {
      const acc = state.accounts[m.account];
      if (!acc) break;

      const balance = (acc.balances[m.mutation.asset] ?? 0n).toString();
      await db
        .insert(schema.balances)
        .values({
          account: m.account,
          asset: m.mutation.asset,
          amount: balance,
        })
        .onConflictDoUpdate({
          target: [schema.balances.account, schema.balances.asset],
          set: { amount: balance },
        });

      await syncNonce(db, state, m.account, m.nonce);
      break;
    }

    case MutationType.LimitOrder: {
      const acc = state.accounts[m.account];
      if (!acc) break;
      const instrument = state.instruments[m.mutation.instrumentId];
      if (!instrument) break;

      const lockedAsset =
        m.mutation.bidOrAsk === 0 ? instrument.quote : instrument.base;
      const balance = (acc.balances[lockedAsset] ?? 0n).toString();
      await db
        .insert(schema.balances)
        .values({ account: m.account, asset: lockedAsset, amount: balance })
        .onConflictDoUpdate({
          target: [schema.balances.account, schema.balances.asset],
          set: { amount: balance },
        });

      const orderIndex = acc.orders.length - 1;
      const order = acc.orders[orderIndex]!;
      await db
        .insert(schema.orders)
        .values({
          account: m.account,
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

      const ticks =
        m.mutation.bidOrAsk === 0 ? instrument.bids : instrument.asks;
      const tick = ticks[Number(m.mutation.price)];
      if (tick) {
        await syncTick(
          db,
          BigInt(m.mutation.instrumentId),
          m.mutation.bidOrAsk,
          m.mutation.price,
          tick,
        );
      }

      await syncNonce(db, state, m.account, m.nonce);
      break;
    }

    case MutationType.MarketOrder: {
      const acc = state.accounts[m.account];
      if (!acc) break;
      const instrument = state.instruments[m.mutation.instrumentId];
      if (!instrument) break;

      for (const asset of [instrument.base, instrument.quote]) {
        const balance = (acc.balances[asset] ?? 0n).toString();
        await db
          .insert(schema.balances)
          .values({ account: m.account, asset, amount: balance })
          .onConflictDoUpdate({
            target: [schema.balances.account, schema.balances.asset],
            set: { amount: balance },
          });
      }

      const fillSide = m.mutation.bidOrAsk === 0 ? 1 : 0;
      const ticks =
        m.mutation.bidOrAsk === 0 ? instrument.asks : instrument.bids;
      for (const fill of m.resolution.fills) {
        const tick = ticks[Number(fill.price)];
        if (tick) {
          await syncTick(
            db,
            BigInt(m.mutation.instrumentId),
            fillSide,
            fill.price,
            tick,
          );
        }
      }

      await syncNonce(db, state, m.account, m.nonce);
      break;
    }

    case MutationType.CloseOrder: {
      const acc = state.accounts[m.account];
      if (!acc) break;

      const order = acc.orders[m.mutation.orderId];
      if (!order) break;
      const instrument = state.instruments[order.instrumentId];
      if (!instrument) break;

      await db
        .insert(schema.orders)
        .values({
          account: m.account,
          orderIndex: BigInt(m.mutation.orderId),
          quantity: order.quantity,
          instrumentId: BigInt(order.instrumentId),
          price: order.price,
          tickVolume: order.tickVolume,
          side: order.side,
        })
        .onConflictDoUpdate({
          target: [schema.orders.account, schema.orders.orderIndex],
          set: { quantity: order.quantity },
        });

      for (const asset of [instrument.base, instrument.quote]) {
        const balance = (acc.balances[asset] ?? 0n).toString();
        await db
          .insert(schema.balances)
          .values({ account: m.account, asset, amount: balance })
          .onConflictDoUpdate({
            target: [schema.balances.account, schema.balances.asset],
            set: { amount: balance },
          });
      }

      const ticks = order.side === 0 ? instrument.bids : instrument.asks;
      const tick = ticks[Number(order.price)];
      if (tick) {
        await syncTick(
          db,
          BigInt(order.instrumentId),
          order.side,
          order.price,
          tick,
        );
      } else {
        await db
          .delete(schema.ticks)
          .where(
            and(
              eq(schema.ticks.instrumentId, BigInt(order.instrumentId)),
              eq(schema.ticks.side, order.side),
              eq(schema.ticks.price, order.price),
            ),
          );
      }

      await syncNonce(db, state, m.account, m.nonce);
      break;
    }

    case MutationType.AddInstrument: {
      await db
        .insert(schema.instruments)
        .values({
          id: BigInt(m.mutation.instrumentId),
          base: m.mutation.base,
          baseLotExp: m.mutation.baseLotExp,
          quote: m.mutation.quote,
          quoteLotExp: m.mutation.quoteLotExp,
        })
        .onConflictDoNothing();
      break;
    }
  }
}

async function syncTick(
  db: DB,
  instrumentId: bigint,
  side: number,
  price: bigint,
  tick: { quantity: bigint; remainingQuantity: bigint; volume: number },
) {
  await db
    .insert(schema.ticks)
    .values({
      instrumentId,
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

export async function insertPendingMutation(
  db: DB,
  m: TaggedMutation,
  id: number,
) {
  await db.insert(schema.mutations).values({
    id,
    bundleId: null,
    status: "pending",
    account: m.account,
    keyIndex: m.type === MutationType.Initialize ? null : BigInt(m.keyId),
    nonce: m.type === MutationType.Initialize ? null : m.nonce.toString(),
    deadline: m.deadline.toString(),
    rawSignature: m.rawSignature,
    type: MUTATION_TYPE_TO_ENUM[m.type],
    calldata: null,
    pendingAt: sql`NOW()`,
  });
}

export async function deletePendingMutation(db: DB, id: number) {
  await db.delete(schema.mutations).where(eq(schema.mutations.id, id));
}

export async function acceptMutation(
  db: DB,
  m: AcceptedMutation,
  bundleId: number,
  bundlePosition: number,
  calldata: Hex,
) {
  await db
    .update(schema.mutations)
    .set({
      status: "accepted",
      bundleId,
      bundlePosition,
      calldata,
      acceptedAt: sql`NOW()`,
    })
    .where(eq(schema.mutations.id, m.id));

  switch (m.type) {
    case MutationType.Initialize:
      await db.insert(schema.initializes).values({
        id: m.id,
        expiry: m.mutation.expiry,
        rootKeyType: m.mutation.rootKeyType,
        keyType: m.mutation.keyType,
        permissions: m.mutation.permissions,
        rootPublicKey: m.mutation.rootPublicKey,
        publicKey: m.mutation.publicKey,
      });
      break;
    case MutationType.Authorize:
      await db.insert(schema.authorizes).values({
        id: m.id,
        expiry: m.mutation.expiry,
        keyType: m.mutation.keyType,
        permissions: m.mutation.permissions,
        publicKey: m.mutation.publicKey,
      });
      break;
    case MutationType.Revoke:
      await db.insert(schema.revokes).values({
        id: m.id,
        revokedKeyId: BigInt(m.mutation.keyId),
      });
      break;
    case MutationType.CloseOrder:
      await db.insert(schema.closeOrders).values({
        id: m.id,
        orderId: BigInt(m.mutation.orderId),
      });
      break;
    case MutationType.LimitOrder:
      await db.insert(schema.limitOrders).values({
        id: m.id,
        quantity: m.mutation.quantity.toString(),
        instrumentId: BigInt(m.mutation.instrumentId),
        price: m.mutation.price,
        bidOrAsk: m.mutation.bidOrAsk,
      });
      break;
    case MutationType.MarketOrder:
      await db.insert(schema.marketOrders).values({
        id: m.id,
        quantity: m.mutation.quantity.toString(),
        minReceivedQuantity: m.mutation.minReceivedQuantity.toString(),
        instrumentId: BigInt(m.mutation.instrumentId),
        bidOrAsk: m.mutation.bidOrAsk,
      });
      for (let i = 0; i < m.resolution.fills.length; i++) {
        const fill = m.resolution.fills[i]!;
        await db.insert(schema.fills).values({
          marketOrderId: m.id,
          fillIndex: i,
          quantity: fill.quantity,
          price: fill.price,
        });
      }
      break;
    case MutationType.AddInstrument:
      await db.insert(schema.addInstruments).values({
        id: m.id,
        instrumentId: BigInt(m.mutation.instrumentId),
        base: m.mutation.base,
        quote: m.mutation.quote,
        baseLotExp: m.mutation.baseLotExp,
        quoteLotExp: m.mutation.quoteLotExp,
      });
      break;
    case MutationType.Deposit:
      await db.insert(schema.deposits).values({
        id: m.id,
        asset: m.mutation.asset,
        amount: m.mutation.amount.toString(),
      });
      break;
    case MutationType.Withdrawal:
      await db.insert(schema.withdrawals).values({
        id: m.id,
        asset: m.mutation.asset,
        amount: m.mutation.amount.toString(),
      });
      break;
  }
}
