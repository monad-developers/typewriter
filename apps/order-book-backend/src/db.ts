import { and, asc, eq, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { Address, Hex } from "viem";
import { MutationType } from "./exchange";
import type { KeyType, Side, State } from "./exchange";
import type { MutationEvent, RuntimeHandle } from "./runtime";
import * as schema from "./schema";

type DB = BunSQLDatabase<typeof schema>;
type DBStatus = "accepted" | "proposed" | "voted" | "finalized" | "verified";

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

export async function loadMaxIds(db: DB): Promise<{ mutationId: number; bundleId: number }> {
  const [bundleRow] = await db
    .select({ max: sql<number>`coalesce(max(${schema.bundles.id}), 0)` })
    .from(schema.bundles);
  const [initRow] = await db
    .select({ max: sql<number>`coalesce(max(${schema.initializes.id}), 0)` })
    .from(schema.initializes);
  const [authRow] = await db
    .select({ max: sql<number>`coalesce(max(${schema.authorizes.id}), 0)` })
    .from(schema.authorizes);
  const [revokeRow] = await db
    .select({ max: sql<number>`coalesce(max(${schema.revokes.id}), 0)` })
    .from(schema.revokes);
  const [closeRow] = await db
    .select({ max: sql<number>`coalesce(max(${schema.closeOrders.id}), 0)` })
    .from(schema.closeOrders);
  const [limitRow] = await db
    .select({ max: sql<number>`coalesce(max(${schema.limitOrders.id}), 0)` })
    .from(schema.limitOrders);
  const [marketRow] = await db
    .select({ max: sql<number>`coalesce(max(${schema.marketOrders.id}), 0)` })
    .from(schema.marketOrders);
  const [addInstRow] = await db
    .select({ max: sql<number>`coalesce(max(${schema.addInstruments.id}), 0)` })
    .from(schema.addInstruments);
  const [depRow] = await db
    .select({ max: sql<number>`coalesce(max(${schema.deposits.id}), 0)` })
    .from(schema.deposits);
  const [wdRow] = await db
    .select({ max: sql<number>`coalesce(max(${schema.withdrawals.id}), 0)` })
    .from(schema.withdrawals);

  const mutationId = Math.max(
    initRow!.max, authRow!.max, revokeRow!.max, closeRow!.max,
    limitRow!.max, marketRow!.max, addInstRow!.max, depRow!.max, wdRow!.max,
  ) + 1;

  return { mutationId, bundleId: bundleRow!.max + 1 };
}

export function dbPlugin(handle: RuntimeHandle, db: DB) {
  handle.on("block", async (block) => {
    await db
      .insert(schema.blocks)
      .values({
        number: block.number.toString(),
        hash: block.hash,
        timestamp: block.timestamp.toString(),
      })
      .onConflictDoNothing();
  });

  handle.on("bundle", async (bundle, status) => {
    if (status === "accepted") {
      await db.insert(schema.bundles).values({ id: bundle.id });
      for (const m of bundle.mutations) {
        await insertMutation(db, m, bundle.id);
        await syncState(db, handle.state, m);
      }
    } else {
      for (const m of bundle.mutations) {
        await updateStatus(db, m.type, m.id, status);
      }
    }
  });
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

async function syncState(db: DB, state: State<bigint>, m: MutationEvent) {
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
        .values({ account: m.account, asset: m.mutation.asset, amount: balance })
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
      target: [schema.ticks.instrumentId, schema.ticks.side, schema.ticks.price],
      set: {
        quantity: tick.quantity,
        remainingQuantity: tick.remainingQuantity,
        volume: tick.volume,
      },
    });
}

async function insertMutation(db: DB, m: MutationEvent, bundleId: number) {
  const base = { id: m.id, bundleId, status: "accepted" as DBStatus };

  switch (m.type) {
    case MutationType.Initialize:
      await db.insert(schema.initializes).values({
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
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
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
        expiry: m.mutation.expiry,
        keyType: m.mutation.keyType,
        permissions: m.mutation.permissions,
        publicKey: m.mutation.publicKey,
      });
      break;
    case MutationType.Revoke:
      await db.insert(schema.revokes).values({
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
        revokedKeyId: BigInt(m.mutation.keyId),
      });
      break;
    case MutationType.CloseOrder:
      await db.insert(schema.closeOrders).values({
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
        orderId: BigInt(m.mutation.orderId),
      });
      break;
    case MutationType.LimitOrder:
      await db.insert(schema.limitOrders).values({
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
        quantity: m.mutation.quantity,
        instrumentId: BigInt(m.mutation.instrumentId),
        price: m.mutation.price,
        bidOrAsk: m.mutation.bidOrAsk,
      });
      break;
    case MutationType.MarketOrder:
      await db.insert(schema.marketOrders).values({
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
        quantity: m.mutation.quantity,
        minReceivedQuantity: m.mutation.minReceivedQuantity,
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
        ...base,
        instrumentId: BigInt(m.mutation.instrumentId),
        base: m.mutation.base,
        quote: m.mutation.quote,
        baseLotExp: m.mutation.baseLotExp,
        quoteLotExp: m.mutation.quoteLotExp,
      });
      break;
    case MutationType.Deposit:
      await db.insert(schema.deposits).values({
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
        asset: m.mutation.asset,
        amount: m.mutation.amount.toString(),
      });
      break;
    case MutationType.Withdrawal:
      await db.insert(schema.withdrawals).values({
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
        asset: m.mutation.asset,
        amount: m.mutation.amount.toString(),
      });
      break;
  }
}

async function updateStatus(
  db: DB,
  type: MutationType,
  id: number,
  status: string,
) {
  const s = status as DBStatus;
  switch (type) {
    case MutationType.Initialize:
      await db
        .update(schema.initializes)
        .set({ status: s })
        .where(eq(schema.initializes.id, id));
      break;
    case MutationType.Authorize:
      await db
        .update(schema.authorizes)
        .set({ status: s })
        .where(eq(schema.authorizes.id, id));
      break;
    case MutationType.Revoke:
      await db
        .update(schema.revokes)
        .set({ status: s })
        .where(eq(schema.revokes.id, id));
      break;
    case MutationType.CloseOrder:
      await db
        .update(schema.closeOrders)
        .set({ status: s })
        .where(eq(schema.closeOrders.id, id));
      break;
    case MutationType.LimitOrder:
      await db
        .update(schema.limitOrders)
        .set({ status: s })
        .where(eq(schema.limitOrders.id, id));
      break;
    case MutationType.MarketOrder:
      await db
        .update(schema.marketOrders)
        .set({ status: s })
        .where(eq(schema.marketOrders.id, id));
      break;
    case MutationType.AddInstrument:
      await db
        .update(schema.addInstruments)
        .set({ status: s })
        .where(eq(schema.addInstruments.id, id));
      break;
    case MutationType.Deposit:
      await db
        .update(schema.deposits)
        .set({ status: s })
        .where(eq(schema.deposits.id, id));
      break;
    case MutationType.Withdrawal:
      await db
        .update(schema.withdrawals)
        .set({ status: s })
        .where(eq(schema.withdrawals.id, id));
      break;
  }
}
