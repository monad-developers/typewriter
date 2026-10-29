import { asc } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { Hash, Hex } from "ox";
import { createStorageView, type StorageView } from "storage-layout";
import { BUILTIN_MUTATIONS } from "../src/client";
import type { TypewriterApp } from "../src/config";
import type { Db } from "../src/db";
import { selectKeccakPreimages, selectStorageSlots } from "../src/db-query";
import type {
  BatchEvent,
  BlockEvent,
  Inclusion,
  MutationEvent,
  MutationStatus,
} from "../src/typewriter-types";
import {
  type AppMutationName,
  mutationKey,
  replay,
  type Signer,
  type Step,
} from "./assessment";
import type {
  AssessmentMutations,
  AssessmentStorage,
} from "./assessment-constants";
import type { Chain } from "./chain";
import type { SIM } from "./index";

/** `state` and `accounts` of a storage view, as plain values. */
type Views = {
  state: { accumulator: Hex.Hex; slots: Record<string, Hex.Hex> };
  accounts: Record<
    string,
    {
      nonces: Record<string, bigint>;
      credentials: { keyType: number; publicKey: Hex.Hex }[];
    }
  >;
};

/**
 * Reads `state` and `accounts` of a storage view into plain values. Mapping
 * keys come from the view's preimages. Leaves may be promises.
 */
async function snapshot<isAsync extends boolean>(
  state: StorageView<AssessmentStorage, isAsync>["state"],
  accounts: StorageView<AssessmentStorage, isAsync>["accounts"],
): Promise<Views> {
  const slots: Record<string, Hex.Hex> = {};
  for (const [key, value] of Object.entries(state.slots)) {
    slots[key] = await value;
  }

  const result: Views["accounts"] = {};
  for (const [accountID, account] of Object.entries(accounts)) {
    const nonces: Record<string, bigint> = {};
    for (const [lane, nonce] of Object.entries(account.nonces)) {
      nonces[lane] = await nonce;
    }
    const credentials: Views["accounts"][string]["credentials"] = [];
    const length = await account.credentials.length;
    for (let i = 0; i < length; i++) {
      const credential = account.credentials[i]!;
      credentials.push({
        keyType: Number(await credential.keyType),
        publicKey: await credential.publicKey,
      });
    }
    result[accountID] = { nonces, credentials };
  }

  return {
    state: { accumulator: await state.accumulator, slots },
    accounts: result,
  };
}

const isHex = (value: string) => /^0x[0-9a-fA-F]*$/.test(value);

/**
 * JSON with sorted keys and lowercase hex, so two reads of the same data
 * compare equal.
 */
const toJson = (value: unknown) =>
  JSON.stringify(value, (_, value) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "string" && isHex(value)) return value.toLowerCase();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]): [string, unknown] => [
          isHex(key) ? key.toLowerCase() : key,
          entry,
        ])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });

/** A row of a mutation table: the shared columns, then one per parameter. */
type MutationRow = {
  execution_index: bigint;
  authorization_account_id: Hex.Hex;
  authorization_credential_id: bigint;
  authorization_nonce: bigint;
  authorization_expiration: bigint;
  block_number: bigint | null;
  block_hash: Hex.Hex | null;
  block_timestamp: bigint | null;
  transaction_hash: Hex.Hex | null;
  transaction_index: number | null;
  [param: string]: unknown;
};

/** One mutation of the run, keyed like the events. */
type Want = {
  key: string;
  label: string;
  name: string;
  params: Record<string, unknown>;
  signer: Signer;
  nonce: bigint;
  expiration: bigint;
  /** Unset for an account creation. */
  step: Step | undefined;
  /** Reverts on `shouldRevert`, or on an expired authorization. */
  reverts: boolean;
  statuses: MutationStatus[];
  isForceInclusion: boolean;
};

/** `expired` holds the keys of the steps whose authorization expired. */
function wants(
  signers: readonly Signer[],
  plan: readonly Step[],
  expired: ReadonlySet<string>,
): Want[] {
  const executed: MutationStatus[] = [
    "received",
    "accepted",
    "included",
    "finalized",
  ];
  const creations = signers.map(
    (signer, index): Want => ({
      key: mutationKey({ accountID: signer.accountID, nonce: 0n }),
      label: `CreateAccount ${index}`,
      name: "CreateAccount",
      params: { keyType: signer.keyType, publicKey: signer.publicKey },
      signer,
      nonce: 0n,
      expiration: 0n,
      step: undefined,
      reverts: false,
      statuses: executed,
      isForceInclusion: false,
    }),
  );
  const steps = plan.map((step): Want => {
    const { mutation } = step;
    const key = mutationKey(mutation.authorization);
    const reverts = mutation.params.shouldRevert || expired.has(key);
    const statuses: MutationStatus[] =
      step.via === "execute"
        ? reverts
          ? ["received", "rejected"]
          : executed
        : reverts
          ? ["rejected"]
          : ["accepted", "included", "finalized"];
    return {
      key,
      label: `step ${step.index} (${step.via} ${mutation.name})`,
      name: mutation.name,
      params: mutation.params,
      signer: step.signer,
      nonce: mutation.authorization.nonce,
      expiration: mutation.authorization.expiration,
      step,
      reverts,
      statuses,
      isForceInclusion: step.via === "enqueue",
    };
  });
  return [...creations, ...steps];
}

/**
 * Checks that the run executed every mutation that does not revert once, in
 * an order the sequencing allows, and that the events, the runtime's views,
 * the database, and Anvil all hold the model replayed in that order. Dies
 * with one line per mismatch.
 */
export function validate({
  app,
  chain,
  db,
  signers,
  plan,
  results,
  mutationEvents,
  batchEvents,
  blockEvents,
  typewriter,
  ordering,
}: {
  app: TypewriterApp;
  chain: Chain;
  db: Db;
  signers: readonly Signer[];
  plan: readonly Step[];
  /** The `executionIndex` that `execute` returned, by mutation key. */
  results: Map<string, bigint>;
  mutationEvents: MutationEvent<AssessmentMutations>[];
  batchEvents: BatchEvent<AssessmentMutations>[];
  blockEvents: BlockEvent<"fifo" | "batch", AssessmentMutations>[];
  /** The runtime, still alive after the drain, to read its views. */
  typewriter: Pick<StorageView<AssessmentStorage, false>, "state" | "accounts">;
  ordering: SIM["typewriter"]["ordering"];
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const errors: string[] = [];
    const equal = (actual: unknown, want: unknown, what: string) => {
      if (toJson(actual) !== toJson(want)) {
        errors.push(`${what}: got ${toJson(actual)}, want ${toJson(want)}`);
      }
    };

    // Whether a finite authorization expires depends on the block it is
    // simulated against, so a step expired when it was rejected on
    // `AuthorizationExpired`, or as expiring within the runtime's margin, and
    // never included. It may have been accepted first, and dropped when its
    // settlement reverted in revm. A rejection of its resubmission alone does
    // not count.
    const expired = new Set<string>();
    const included = new Set<string>();
    for (const event of mutationEvents) {
      const key = mutationKey(event.authorization);
      if (event.status === "included") included.add(key);
      if (
        event.status === "rejected" &&
        (event.error._tag === "MutationExpiresTooSoonError" ||
          (event.error._tag === "MutationRevertedError" &&
            event.error.errorName === "AuthorizationExpired"))
      ) {
        expired.add(key);
      }
    }
    for (const key of included) expired.delete(key);

    const all = wants(signers, plan, expired);
    // A negative `expiresInS` always expires, and an infinite one, like an
    // account creation's, never does.
    for (const want of all) {
      const expiresInS = want.step?.expiresInS ?? Infinity;
      if (expiresInS >= 0 && Number.isFinite(expiresInS)) continue;
      equal(
        expired.has(want.key),
        expiresInS < 0,
        `${want.label} authorization expired (expiresInS ${expiresInS})`,
      );
    }
    const byKey = new Map(all.map((want) => [want.key, want]));

    // The statuses of each mutation, in order, and where it executed.
    const events = new Map<string, typeof mutationEvents>();
    for (const event of mutationEvents) {
      const key = mutationKey(event.authorization);
      if (!byKey.has(key)) {
        errors.push(`mutation event for an unknown mutation: ${key}`);
        continue;
      }
      events.set(key, [...(events.get(key) ?? []), event]);
    }
    /** Records the first value of `want`, and checks that later ones match it. */
    const agree = <value>(
      map: Map<string, value>,
      want: Want,
      value: value,
      what: string,
    ) => {
      if (!map.has(want.key)) map.set(want.key, value);
      else equal(value, map.get(want.key), `${want.label} ${what}`);
    };
    const executionIndexes = new Map<string, bigint>();
    /** The index of a mutation's first `accepted` event, which `execute` returns. */
    const firstExecutionIndexes = new Map<string, bigint>();
    const queueIndexes = new Map<string, bigint>();
    const inclusions = new Map<string, Inclusion>();
    for (const want of all) {
      let seen = events.get(want.key) ?? [];
      // A resubmission shares its key: its events are the second `received`
      // and the last `rejected`.
      if (want.step?.resubmit) {
        const second = seen.findIndex(
          (event, i) =>
            event.status === "received" &&
            seen.findIndex((other) => other.status === "received") < i,
        );
        const last = seen.findLastIndex((event) => event.status === "rejected");
        equal(
          [seen[second]?.status, seen[last]?.status],
          ["received", "rejected"],
          `${want.label} resubmission event statuses`,
        );
        seen = seen.filter((_, i) => i !== second && i !== last);
      }
      // When a settlement reverts in revm, its mutations execute again: each
      // one is accepted again, maybe at a new execution index, or rejected if
      // it expired since.
      const statuses = seen
        .map((event) => event.status)
        .filter(
          (status, i, all) => status !== "accepted" || all[i - 1] !== status,
        );
      const dropped =
        expired.has(want.key) &&
        statuses.at(-1) === "rejected" &&
        statuses.at(-2) === "accepted";
      equal(
        dropped ? statuses.filter((status) => status !== "accepted") : statuses,
        want.statuses,
        `${want.label} mutation event statuses`,
      );
      for (const event of seen) {
        if ("isForceInclusion" in event) {
          equal(
            event.isForceInclusion,
            want.isForceInclusion,
            `${want.label} ${event.status} event isForceInclusion`,
          );
          if (event.isForceInclusion) {
            agree(queueIndexes, want, event.queueIndex, "queueIndex");
          }
        }
        if (event.status === "accepted") {
          executionIndexes.set(want.key, event.executionIndex);
          if (!firstExecutionIndexes.has(want.key)) {
            firstExecutionIndexes.set(want.key, event.executionIndex);
          }
        } else if ("executionIndex" in event) {
          agree(executionIndexes, want, event.executionIndex, "executionIndex");
        }
        if (event.status === "included" || event.status === "finalized") {
          agree(
            inclusions,
            want,
            {
              blockNumber: event.blockNumber,
              blockHash: event.blockHash,
              blockTimestamp: event.blockTimestamp,
              transactionHash: event.transactionHash,
              transactionIndex: event.transactionIndex,
            },
            "inclusion",
          );
        }
      }
    }

    // `execute` returns the index of the first `accepted` event, which a
    // reverted settlement simulation may change later.
    for (const [key, executionIndex] of results) {
      equal(
        executionIndex,
        firstExecutionIndexes.get(key),
        `${byKey.get(key)?.label} execute result`,
      );
    }

    // The execution order: account creations first, then every step that
    // does not revert, with no gaps.
    const executed = all.filter((want) => !want.reverts);
    const order = [...executed].sort((a, b) => {
      const x = executionIndexes.get(a.key) ?? -1n;
      const y = executionIndexes.get(b.key) ?? -1n;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    equal(
      order.map((want) => executionIndexes.get(want.key)),
      order.map((_, i) => BigInt(i)),
      "execution indexes",
    );
    equal(
      order.slice(0, signers.length).map((want) => want.label),
      signers.map((_, index) => `CreateAccount ${index}`),
      "account creations execute first",
    );

    // Enqueued mutations take queue indexes in plan order, since the client
    // sends one transaction at a time, and execute in queue order.
    const enqueues = all.filter((want) => want.step?.via === "enqueue");
    equal(
      enqueues.map((want) => queueIndexes.get(want.key)),
      enqueues.map((_, i) => BigInt(i)),
      "queue indexes",
    );
    equal(
      order.filter((want) => want.step?.via === "enqueue").map((w) => w.label),
      enqueues.filter((want) => !want.reverts).map((w) => w.label),
      "enqueued execution order",
    );

    // Executed mutations arrive in the order of their `received` events. FIFO
    // executes them in that order. Batch takes runs of arrivals as batches
    // and orders each batch by `batchOrder`, keeping arrival order within a
    // name.
    // A resubmission arrives after its first submission, so only the first
    // `received` of a key counts.
    const arrivals = [
      ...new Set(
        mutationEvents
          .filter(
            (event) =>
              event.status === "received" &&
              byKey.get(mutationKey(event.authorization))?.step !== undefined,
          )
          .map((event) => byKey.get(mutationKey(event.authorization))!),
      ),
    ].filter((want) => !want.reverts);
    const executions = order.filter((want) => want.step?.via === "execute");
    if (ordering.order === "fifo") {
      equal(
        executions.map((want) => want.label),
        arrivals.map((want) => want.label),
        "FIFO execution order",
      );
    } else {
      const rank = (name: string) =>
        ordering.batchOrder.indexOf(name as AppMutationName);
      const batches = batchEvents
        .filter((event) => event.status === "accepted")
        .map((event) =>
          event.mutations
            .map((mutation) => byKey.get(mutationKey(mutation.authorization))!)
            // A mutation dropped from a reverted settlement leaves its batch.
            .filter((want) => want.step !== undefined && !want.reverts),
        )
        .filter((batch) => batch.length > 0);
      const arrival = new Map(arrivals.map((want, i) => [want.key, i]));
      const byArrival = (a: Want, b: Want) =>
        arrival.get(a.key)! - arrival.get(b.key)!;
      equal(
        batches.flatMap((batch) =>
          [...batch].sort(byArrival).map((want) => want.label),
        ),
        arrivals.map((want) => want.label),
        "batches are runs of arrivals",
      );
      for (const [i, batch] of batches.entries()) {
        equal(
          batch.map((want) => want.label),
          [...batch]
            .sort((a, b) => rank(a.name) - rank(b.name) || byArrival(a, b))
            .map((want) => want.label),
          `batch ${i} order`,
        );
      }
      equal(
        executions.map((want) => want.label),
        batches.flat().map((want) => want.label),
        "batch execution order",
      );
    }

    // Block events: each block is included, then finalized, and the blocks
    // hold every executed mutation once, in execution order.
    const blocks = new Map<Hex.Hex, typeof blockEvents>();
    for (const event of blockEvents) {
      blocks.set(event.hash, [...(blocks.get(event.hash) ?? []), event]);
    }
    const blockOrder: bigint[] = [];
    for (const [hash, seen] of blocks) {
      equal(
        seen.map((event) => event.status),
        ["included", "finalized"],
        `block ${hash} event statuses`,
      );
      const indexes = seen.map((event) =>
        ("mutations" in event
          ? event.mutations
          : [
              ...event.batches.flatMap((batch) => batch.mutations),
              ...event.forceIncludedMutations,
            ]
        ).map((mutation) => mutation.executionIndex),
      );
      for (const other of indexes.slice(1)) {
        equal(other, indexes[0], `block ${hash} finalized mutations`);
      }
      blockOrder.push(...(indexes[0] ?? []));

      const event = seen[0]!;
      const block = yield* chain.request({
        method: "eth_getBlockByNumber",
        params: [Hex.fromNumber(event.number), false],
      });
      equal(block?.hash, hash, `block ${event.number} hash on Anvil`);
      equal(
        block === null ? undefined : BigInt(block.timestamp),
        event.timestamp,
        `block ${hash} timestamp on Anvil`,
      );
      const receipt = yield* chain.request({
        method: "eth_getTransactionReceipt",
        params: [event.transactionHash],
      });
      equal(
        receipt?.status,
        "0x1",
        `transaction ${event.transactionHash} status`,
      );
      equal(
        receipt?.blockHash,
        hash,
        `transaction ${event.transactionHash} block`,
      );
    }
    equal(
      blockOrder,
      executed.map((_, i) => BigInt(i)),
      "execution indexes across block events",
    );

    // `typewriter.state` and `typewriter.accounts`, against the model
    // replayed in the observed order, and against the same views over Anvil
    // storage.
    const expected = replay(
      order.flatMap((want) => (want.step === undefined ? [] : [want.step])),
    );
    const wantViews: Views = {
      state: {
        accumulator: expected.accumulator,
        slots: Object.fromEntries(
          [...expected.slots].map(([slot, value]) => [slot.toString(), value]),
        ),
      },
      accounts: Object.fromEntries(
        signers.map((signer) => [
          signer.accountID,
          {
            nonces: Object.fromEntries(
              executed
                .filter((want) => want.signer === signer && want.step)
                .map((want) => [(want.nonce >> 64n).toString(), 1n]),
            ),
            credentials: [
              { keyType: signer.keyType, publicKey: signer.publicKey },
            ],
          },
        ]),
      ),
    };
    const runtimeViews = yield* Effect.promise(() =>
      snapshot(typewriter.state, typewriter.accounts),
    );
    equal(runtimeViews.state, wantViews.state, "typewriter.state");
    equal(runtimeViews.accounts, wantViews.accounts, "typewriter.accounts");

    const preimages = yield* db
      .transaction((tx) => selectKeccakPreimages(tx, app.typewriterSchema))
      .pipe(Effect.orDie);
    const chainStorage = createStorageView(
      app.storageLayout,
      (slots) =>
        Promise.all(
          slots.map((slot) =>
            Effect.runPromise(
              chain.request({
                method: "eth_getStorageAt",
                params: [app.address, slot, "latest"],
              }),
            ),
          ),
        ),
      new Set(preimages),
    );
    const chainViews = yield* Effect.promise(() =>
      // biome-ignore lint/complexity/useLiteralKeys: generic storage layouts expose root variables through an index signature.
      snapshot(chainStorage["state"], chainStorage["accounts"]),
    );
    equal(chainViews.state, wantViews.state, "state on Anvil");
    equal(chainViews.accounts, wantViews.accounts, "accounts on Anvil");

    equal(
      // biome-ignore lint/complexity/useLiteralKeys: generic storage layouts expose root variables through an index signature.
      yield* Effect.promise(async () => chainStorage["executionIndex"]),
      BigInt(executed.length),
      "executionIndex on Anvil",
    );

    // `storage_slots`: the latest value of each slot is the value on Anvil.
    const storage = yield* db
      .transaction((tx) => selectStorageSlots(tx, app.typewriterSchema))
      .pipe(Effect.orDie);
    for (const [slot, value] of Object.entries(storage) as [
      Hex.Hex,
      Hex.Hex,
    ][]) {
      const onchain = yield* chain.request({
        method: "eth_getStorageAt",
        params: [app.address, slot, "latest"],
      });
      equal(value, onchain, `storage_slots ${slot}`);
    }

    // The mutation tables.
    const rows: { name: string; row: MutationRow }[] = [];
    for (const name of Object.keys(app.mutations)) {
      const table = app.mutationSchema[
        `${name.toLowerCase()}_mutations`
      ] as PgTable & { execution_index: never };
      const found = yield* db
        .query((d) =>
          d.select().from(table).orderBy(asc(table.execution_index)),
        )
        .pipe(Effect.orDie);
      for (const row of found as MutationRow[]) rows.push({ name, row });
    }
    equal(
      rows
        .map(({ row }) => row.execution_index)
        .sort((a, b) => (a < b ? -1 : 1)),
      executed.map((_, i) => BigInt(i)),
      "mutation table execution indexes",
    );
    const byIndex = new Map(
      rows.map((entry) => [entry.row.execution_index, entry]),
    );
    for (const want of executed) {
      const entry = byIndex.get(executionIndexes.get(want.key) ?? -1n);
      if (entry === undefined) continue;
      const { name, row } = entry;
      equal(name, want.name, `${want.label} table`);
      equal(
        {
          accountID: row.authorization_account_id,
          credentialID: row.authorization_credential_id,
          nonce: row.authorization_nonce,
          expiration: row.authorization_expiration,
          ...Object.fromEntries(
            Object.keys(want.params).map((param) => [param, row[param]]),
          ),
        },
        {
          accountID: want.signer.accountID,
          credentialID: 0n,
          nonce: want.nonce,
          expiration: want.expiration,
          ...want.params,
        },
        `${want.label} row`,
      );
      // The contract accepts an authorization up to and including the second
      // of its expiration.
      const blockTimestamp = inclusions.get(want.key)?.blockTimestamp;
      if (
        want.expiration !== 0n &&
        blockTimestamp !== undefined &&
        blockTimestamp > want.expiration
      ) {
        errors.push(
          `${want.label} included at ${blockTimestamp}, after its expiration ${want.expiration}`,
        );
      }
      equal(
        {
          blockNumber: row.block_number,
          blockHash: row.block_hash,
          blockTimestamp: row.block_timestamp,
          transactionHash: row.transaction_hash,
          transactionIndex: row.transaction_index,
        },
        inclusions.get(want.key),
        `${want.label} row inclusion`,
      );
    }
    for (const builtin of Object.keys(BUILTIN_MUTATIONS)) {
      if (builtin === "CreateAccount") continue;
      equal(
        rows.filter(({ name }) => name === builtin).length,
        0,
        `${builtin} rows`,
      );
    }

    // `typewriter_metadata`.
    const metadata = yield* db
      .query((d) => d.select().from(app.typewriterSchema.typewriterMetadata))
      .pipe(Effect.orDie);
    const code = yield* chain.request({
      method: "eth_getCode",
      params: [app.address, "latest"],
    });
    equal(
      metadata,
      [
        {
          schema_version: 1,
          address: app.address,
          chain_id: app.chainId,
          code_hash: Hash.keccak256(code),
        },
      ],
      "typewriter_metadata",
    );

    if (errors.length > 0) return yield* Effect.die(errors.join("\n"));
  });
}
