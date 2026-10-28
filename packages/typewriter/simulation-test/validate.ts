import { abiParametersToValues } from "abipg";
import { asc } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { Effect, Exit } from "effect";
import { Hash, type Hex } from "ox";
import { createStorageView, type StorageView } from "storage-layout";
import type { TypewriterApp } from "../src/config";
import type { Db } from "../src/db";
import { selectKeccakPreimages, selectStorageSlots } from "../src/db-query";
import { encodeExecuteCalldata } from "../src/encoding";
import type { RpcRequest } from "../src/rpc-transport";
import type {
  BlockEvent,
  MutationEvent,
  MutationStatus,
} from "../src/typewriter-types";
import type { AppMutationName } from "./assessment";
import type {
  AssessmentMutations,
  AssessmentStorage,
} from "./assessment-constants";
import type { Chain } from "./chain";
import type { SIM } from "./index";
import {
  type Executed,
  encodingOf,
  type Onchain,
  readOnchain,
} from "./onchain";
import {
  errorName,
  mutationKey,
  type Result,
  type Run,
  type Submission,
} from "./run";

type Params = {
  app: TypewriterApp;
  chain: Chain;
  db: Db;
  run: Run;
  /** The runtime, still alive after the drain, to read its views. */
  typewriter: Pick<StorageView<AssessmentStorage, false>, "state" | "accounts">;
  ordering: SIM["typewriter"]["ordering"];
};

/**
 * Checks the run against the chain. First the harness's own rules: what
 * executed, and in what order. Then the chain is the source of truth for the
 * runtime's events, its database, and its state. Dies with one line per
 * mismatch.
 */
export function validate(params: Params): Effect.Effect<void> {
  return Effect.gen(function* () {
    const { app, chain, run } = params;
    const onchain = yield* readOnchain({
      app,
      chain,
      submissions: run.submissions,
    });
    const check = makeCheck(run);

    checkSettlements(check, onchain, app);
    checkOutcomes(check, run, onchain);
    checkArrivals(check, run, onchain, params.ordering);
    checkFinality(check, run, onchain);
    yield* checkQueue(check, run, onchain, params);

    checkMutationEvents(check, run, onchain);
    checkBatchEvents(check, run, onchain, params.ordering);
    checkBlockEvents(check, run, onchain);
    yield* checkDatabase(check, onchain, params);
    yield* checkRuntimeState(check, onchain, params);

    if (check.errors.length > 0) {
      return yield* Effect.die(check.errors.join("\n"));
    }
  });
}

type Check = {
  errors: string[];
  fail: (message: string) => void;
  equal: (actual: unknown, want: unknown, what: string) => void;
  /** The submission of each key. */
  submissions: Map<string, Submission>;
  label: (key: string) => string;
};

function makeCheck(run: Run): Check {
  const errors: string[] = [];
  const submissions = new Map(
    run.submissions.map((submission) => [submission.key, submission]),
  );
  return {
    errors,
    fail: (message) => errors.push(message),
    equal: (actual, want, what) => {
      if (toJson(actual) !== toJson(want)) {
        errors.push(`${what}: got ${toJson(actual)}, want ${toJson(want)}`);
      }
    },
    submissions,
    label: (key) => submissions.get(key)?.label ?? key,
  };
}

/**
 * Every settlement succeeded, and executed only submitted mutations, each
 * once, encoded as they were signed.
 */
function checkSettlements(check: Check, onchain: Onchain, app: TypewriterApp) {
  for (const settlement of onchain.settlements) {
    if (settlement.reverted) {
      check.fail(`settlement ${settlement.transactionHash} reverted`);
    }
  }
  const seen = new Set<string>();
  for (const { key, executionIndex, encoding } of onchain.executed) {
    const submission = check.submissions.get(key);
    if (submission === undefined) {
      check.fail(`execution index ${executionIndex}: no one submitted ${key}`);
      continue;
    }
    if (seen.has(key)) {
      check.fail(`${submission.label}: executed again at ${executionIndex}`);
    }
    seen.add(key);
    if (encoding !== undefined) {
      check.equal(
        encoding,
        encodingOf(app, submission),
        `${submission.label} settled encoding`,
      );
    }
  }
}

/**
 * Each submission ended as expected: it executed onchain, or it was rejected
 * with an error its submission explains. An expiry is checked against the
 * chain at the time of the rejection.
 */
function checkOutcomes(check: Check, run: Run, onchain: Onchain) {
  const executed = executedByKey(onchain);
  const events = eventsByKey(run);

  for (const submission of run.submissions) {
    const { label, key, expected } = submission;
    const onChain = executed.get(key);
    const rejections = (events.get(key) ?? []).flatMap((event) =>
      event.status === "rejected" ? [errorName(event.error)] : [],
    );
    const allowed = submission.resubmitted
      ? [...expected.errors, ...expected.resubmissionErrors]
      : expected.errors;
    const want =
      allowed.length === 0
        ? "no rejection"
        : `rejected with ${allowed.join(" or ")}`;

    if (onChain !== undefined && !expected.executes) {
      check.fail(
        `${label}: executed at ${onChain.executionIndex}, want ${want}`,
      );
    }
    for (const error of rejections) {
      if (!allowed.includes(error)) {
        check.fail(`${label}: rejected with ${error}, want ${want}`);
      }
    }
    if (!expected.events && events.has(key)) {
      check.fail(`${label}: has mutation events, want none`);
    }
    const [first, resubmission] = submission.results;
    if (
      onChain === undefined &&
      expected.executes &&
      rejections.length === 0 &&
      (first === undefined || "executionIndex" in first)
    ) {
      check.fail(`${label}: never executed`);
    }
    if (first !== undefined) {
      checkResult(check, `${label} execute`, first, expected.errors, onChain);
    }
    if (resubmission !== undefined) {
      checkResult(
        check,
        `${label} resubmission`,
        resubmission,
        expected.resubmissionErrors,
        undefined,
      );
    }
  }

  for (const { key, expiration, latestTimestamp } of run.expiryChecks) {
    // The contract expires an authorization once `block.timestamp` passes it.
    if (expiration === 0n || expiration >= latestTimestamp) {
      check.fail(
        `${check.label(key)}: rejected as expired at ${expiration}, but the latest block is at ${latestTimestamp}`,
      );
    }
  }
}

/** `execute` returned the execution index the chain shows, or an allowed error. */
function checkResult(
  check: Check,
  what: string,
  result: Result,
  allowed: string[],
  onChain: Executed | undefined,
) {
  if ("error" in result) {
    if (!allowed.includes(result.error)) {
      check.fail(
        `${what}: got ${result.error}, want ${allowed.join(" or ") || "success"}`,
      );
    }
    return;
  }
  check.equal(result.executionIndex, onChain?.executionIndex, `${what} result`);
}

/**
 * `execute` emits `received` before it waits, so arrival order is call order.
 * FIFO executes in arrival order. Batch sequencing takes runs of arrivals as
 * batches, each in `batchOrder` and then arrival order. Enqueued mutations
 * execute in queue order.
 */
function checkArrivals(
  check: Check,
  run: Run,
  onchain: Onchain,
  ordering: SIM["typewriter"]["ordering"],
) {
  for (const key of run.lateArrivals) {
    check.fail(
      `${check.label(key)}: execute waited before it emitted received`,
    );
  }

  const arrival = new Map<string, number>();
  for (const event of run.mutationEvents) {
    const key = mutationKey(event.authorization);
    if (event.status === "received" && !arrival.has(key)) {
      arrival.set(key, arrival.size);
    }
  }
  const executed = executedByKey(onchain);
  const arrived = [...arrival.keys()].filter((key) => executed.has(key));
  const byArrival = (a: string, b: string) =>
    (arrival.get(a) ?? Infinity) - (arrival.get(b) ?? Infinity);
  const labels = (keys: readonly string[]) => keys.map(check.label);

  if (ordering.order === "fifo") {
    check.equal(
      labels(onchain.batches.flat()),
      labels(arrived),
      "FIFO execution order",
    );
  } else {
    const rank = (key: string) => {
      const name = check.submissions.get(key)?.mutation.name ?? "";
      const builtin = BUILTIN_ORDER.indexOf(name);
      return builtin >= 0
        ? builtin
        : BUILTIN_ORDER.length +
            ordering.batchOrder.indexOf(name as AppMutationName);
    };
    check.equal(
      labels(onchain.batches.flatMap((batch) => [...batch].sort(byArrival))),
      labels(arrived),
      "batches are runs of arrivals",
    );
    for (const [i, batch] of onchain.batches.entries()) {
      check.equal(
        labels(batch),
        labels([...batch].sort((a, b) => rank(a) - rank(b) || byArrival(a, b))),
        `batch ${i} order`,
      );
    }
  }

  const forced = onchain.executed.flatMap(({ queueIndex }) =>
    queueIndex === undefined ? [] : [queueIndex],
  );
  check.equal(forced, [...forced].sort(compareBigInt), "force-execution order");
}

/** The runtime sorts built-in mutations first in a batch. */
const BUILTIN_ORDER = ["CreateAccount", "AddCredential", "RemoveCredential"];

/** A finalized block is on the canonical chain, and no reorg replaced it. */
function checkFinality(check: Check, run: Run, onchain: Onchain) {
  const replaced = new Set(
    run.reorgs.flatMap(({ replaced }) =>
      replaced.map((hash) => hash.toLowerCase()),
    ),
  );
  for (const { status, number, hash } of run.blockEvents) {
    if (status !== "finalized") continue;
    if (replaced.has(hash.toLowerCase())) {
      check.fail(`block ${number} ${hash}: finalized, but a reorg replaced it`);
    } else if (
      onchain.blockHashes.get(number)?.toLowerCase() !== hash.toLowerCase()
    ) {
      check.fail(`block ${number} ${hash}: finalized, but not canonical`);
    }
  }
}

/**
 * Every enqueue that never executed stays in the queue, where anyone can
 * force-execute it. It must revert, or it would change state outside the
 * runtime.
 */
function checkQueue(
  check: Check,
  run: Run,
  onchain: Onchain,
  { app, chain }: Params,
) {
  return Effect.gen(function* () {
    const executed = executedByKey(onchain);
    for (const { label, key, via, transactionHash } of run.submissions) {
      if (via !== "enqueue" || executed.has(key)) continue;
      const queueIndex = onchain.queueIndexes.get(transactionHash!);
      if (queueIndex === undefined) {
        check.fail(`${label}: enqueue is not on the canonical chain`);
        continue;
      }
      // Anvil answers a reverting call with an error.
      const call = yield* Effect.exit(
        chain.request({
          method: "eth_call",
          params: [
            {
              from: app.account.address,
              to: app.address,
              data: encodeExecuteCalldata([], [queueIndex]),
            },
            "latest",
          ],
        }),
      );
      if (Exit.isSuccess(call)) {
        check.fail(
          `${label}: queue index ${queueIndex} never executed, but it can be force-executed`,
        );
      }
    }
  });
}

/**
 * Each submission's events follow from how it ended, and an executed one's
 * report its execution index, inclusion, and queue index as onchain.
 */
function checkMutationEvents(check: Check, run: Run, onchain: Onchain) {
  const executed = executedByKey(onchain);
  const events = eventsByKey(run);
  for (const key of events.keys()) {
    if (!check.submissions.has(key)) {
      check.fail(`mutation events for a mutation no one submitted: ${key}`);
    }
  }

  for (const submission of run.submissions) {
    const { label, key, via } = submission;
    let seen = events.get(key) ?? [];
    // A resubmission shares its key: its events are the second `received`
    // and the last `rejected`.
    if (submission.resubmitted) {
      const second = seen.findIndex(
        (event, i) =>
          event.status === "received" &&
          seen.findIndex((other) => other.status === "received") < i,
      );
      const last = seen.findLastIndex((event) => event.status === "rejected");
      check.equal(
        [seen[second]?.status, seen[last]?.status],
        ["received", "rejected"],
        `${label} resubmission event statuses`,
      );
      seen = seen.filter((_, i) => i !== second && i !== last);
    }

    const onChain = executed.get(key);
    const statuses: MutationStatus[] =
      onChain !== undefined
        ? ["accepted", "included", "finalized"]
        : submission.expected.events
          ? ["rejected"]
          : [];
    check.equal(
      seen.map((event) => event.status),
      via === "execute" && statuses.length > 0
        ? ["received", ...statuses]
        : statuses,
      `${label} mutation event statuses`,
    );
    if (onChain === undefined) continue;

    for (const event of seen) {
      if ("executionIndex" in event) {
        check.equal(
          event.executionIndex,
          onChain.executionIndex,
          `${label} ${event.status} event executionIndex`,
        );
      }
      if ("isForceInclusion" in event) {
        check.equal(
          event.isForceInclusion ? event.queueIndex : undefined,
          onChain.queueIndex,
          `${label} ${event.status} event queueIndex`,
        );
      }
      if (event.status === "included" || event.status === "finalized") {
        check.equal(
          {
            blockNumber: event.blockNumber,
            blockHash: event.blockHash,
            blockTimestamp: event.blockTimestamp,
            transactionHash: event.transactionHash,
            transactionIndex: event.transactionIndex,
          },
          onChain.inclusion,
          `${label} ${event.status} event inclusion`,
        );
      }
    }
  }
}

/** Each accepted batch is a batch onchain, and goes on to be included and finalized. */
function checkBatchEvents(
  check: Check,
  run: Run,
  onchain: Onchain,
  ordering: SIM["typewriter"]["ordering"],
) {
  if (ordering.order === "fifo") {
    check.equal(run.batchEvents.length, 0, "batch events with FIFO sequencing");
    return;
  }
  const accepted = run.batchEvents.filter(
    (event) => event.status === "accepted",
  );
  check.equal(
    accepted.map((event) =>
      event.mutations.map((mutation) =>
        check.label(mutationKey(mutation.authorization)),
      ),
    ),
    onchain.batches.map((batch) => batch.map(check.label)),
    "accepted batches",
  );
  for (const { id } of accepted) {
    check.equal(
      run.batchEvents
        .filter((event) => event.id === id)
        .map((event) => event.status),
      ["accepted", "included", "finalized"],
      `batch ${id} event statuses`,
    );
  }
}

/** Each settlement's block is included, then finalized, with the mutations it executed. */
function checkBlockEvents(check: Check, run: Run, onchain: Onchain) {
  const byHash = new Map<string, typeof run.blockEvents>();
  for (const event of run.blockEvents) {
    const hash = event.hash.toLowerCase();
    byHash.set(hash, [...(byHash.get(hash) ?? []), event]);
  }

  const settled = new Set<string>();
  for (const settlement of onchain.settlements) {
    if (settlement.reverted) continue;
    const hash = settlement.blockHash.toLowerCase();
    settled.add(hash);
    const seen = byHash.get(hash) ?? [];
    const what = `block ${settlement.blockNumber}`;
    check.equal(
      seen.map((event) => event.status),
      ["included", "finalized"],
      `${what} event statuses`,
    );
    for (const event of seen) {
      check.equal(
        {
          number: event.number,
          timestamp: event.timestamp,
          transactionHash: event.transactionHash,
          executionIndexes: executionIndexesOf(event),
        },
        {
          number: settlement.blockNumber,
          timestamp: settlement.blockTimestamp,
          transactionHash: settlement.transactionHash,
          executionIndexes: settlement.executionIndexes,
        },
        `${what} ${event.status} event`,
      );
    }
  }
  for (const [hash, [event]] of byHash) {
    if (!settled.has(hash)) {
      check.fail(
        `block ${event!.number} ${hash}: block events, but it settled nothing`,
      );
    }
  }
}

/** A row of a mutation table: the shared columns, then one per parameter. */
type MutationRow = { execution_index: bigint; [column: string]: unknown };

/**
 * The mutation tables hold exactly the executed mutations, `storage_slots`
 * holds every slot a settlement wrote at its value onchain, and
 * `typewriter_metadata` describes the deployment.
 */
function checkDatabase(
  check: Check,
  onchain: Onchain,
  { app, chain, db }: Params,
) {
  return Effect.gen(function* () {
    const rows = new Map<bigint, { name: string; row: MutationRow }>();
    for (const name of Object.keys(app.mutations)) {
      const table = app.mutationSchema[
        `${name.toLowerCase()}_mutations`
      ] as PgTable & {
        execution_index: never;
      };
      const found = yield* db
        .query((d) =>
          d.select().from(table).orderBy(asc(table.execution_index)),
        )
        .pipe(Effect.orDie);
      for (const row of found as MutationRow[]) {
        rows.set(row.execution_index, { name, row });
      }
    }
    check.equal(
      [...rows.keys()].sort(compareBigInt),
      onchain.executed.map(({ executionIndex }) => executionIndex),
      "mutation table execution indexes",
    );
    for (const { key, executionIndex, inclusion } of onchain.executed) {
      const submission = check.submissions.get(key);
      const entry = rows.get(executionIndex);
      if (submission === undefined || entry === undefined) continue;
      const { name, params, authorization } = submission.mutation;
      check.equal(entry.name, name, `${submission.label} table`);
      const want = {
        execution_index: executionIndex,
        authorization_account_id: authorization.accountID,
        authorization_credential_id: authorization.credentialID,
        authorization_nonce: authorization.nonce,
        authorization_expiration: authorization.expiration,
        authorization_signature: authorization.signature,
        ...abiParametersToValues(app.mutations[name]!.params, params as never),
        block_number: inclusion.blockNumber,
        block_hash: inclusion.blockHash,
        block_timestamp: inclusion.blockTimestamp,
        transaction_hash: inclusion.transactionHash,
        transaction_index: inclusion.transactionIndex,
      };
      check.equal(
        Object.fromEntries(
          Object.keys(want).map((column) => [column, entry.row[column]]),
        ),
        want,
        `${submission.label} row`,
      );
    }

    const storage = yield* db
      .transaction((tx) => selectStorageSlots(tx, app.typewriterSchema))
      .pipe(Effect.orDie);
    const stored = new Set(
      Object.keys(storage).map((slot) => slot.toLowerCase()),
    );
    for (const [slot, value] of Object.entries(storage) as [
      Hex.Hex,
      Hex.Hex,
    ][]) {
      const onChain = yield* chain.request({
        method: "eth_getStorageAt",
        params: [app.address, slot, "latest"],
      });
      check.equal(value, onChain, `storage_slots ${slot}`);
    }
    for (const settlement of onchain.settlements) {
      if (settlement.reverted) continue;
      for (const slot of yield* slotsWritten(
        chain,
        app,
        settlement.transactionHash,
      )) {
        if (!stored.has(slot)) {
          check.fail(
            `storage_slots: missing ${slot}, which settlement ${settlement.transactionHash} wrote`,
          );
        }
      }
    }

    const metadata = yield* db
      .query((d) => d.select().from(app.typewriterSchema.typewriterMetadata))
      .pipe(Effect.orDie);
    const code = yield* chain.request({
      method: "eth_getCode",
      params: [app.address, "latest"],
    });
    check.equal(
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
  });
}

/** The slots of the app that transaction `hash` changed. */
function slotsWritten(chain: Chain, app: TypewriterApp, hash: Hex.Hex) {
  return Effect.gen(function* () {
    type Diff = Record<string, { storage?: Record<string, Hex.Hex> }>;
    // `PublicRpcSchema` does not include `debug_traceTransaction`.
    const trace = (yield* chain.request({
      method: "debug_traceTransaction",
      params: [
        hash,
        { tracer: "prestateTracer", tracerConfig: { diffMode: true } },
      ],
    } as unknown as RpcRequest)) as unknown as { pre: Diff; post: Diff };
    const address = app.address.toLowerCase();
    return [
      ...new Set(
        [trace.pre, trace.post].flatMap((diff) =>
          Object.keys(diff[address]?.storage ?? {}).map((slot) =>
            slot.toLowerCase(),
          ),
        ),
      ),
    ];
  });
}

/** `state` and `accounts` of the runtime match the same views over Anvil storage. */
function checkRuntimeState(
  check: Check,
  onchain: Onchain,
  { app, chain, db, typewriter }: Params,
) {
  return Effect.gen(function* () {
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
    const [runtimeViews, chainViews] = yield* Effect.promise(() =>
      Promise.all([
        snapshot(typewriter.state, typewriter.accounts),
        // biome-ignore lint/complexity/useLiteralKeys: generic storage layouts expose root variables through an index signature.
        snapshot(chainStorage["state"], chainStorage["accounts"]),
      ]),
    );
    check.equal(runtimeViews.state, chainViews.state, "typewriter.state");
    check.equal(
      runtimeViews.accounts,
      chainViews.accounts,
      "typewriter.accounts",
    );
    check.equal(
      // biome-ignore lint/complexity/useLiteralKeys: generic storage layouts expose root variables through an index signature.
      yield* Effect.promise(async () => chainStorage["executionIndex"]),
      BigInt(onchain.executed.length),
      "executionIndex on Anvil",
    );
  });
}

function executedByKey(onchain: Onchain): Map<string, Executed> {
  return new Map(onchain.executed.map((executed) => [executed.key, executed]));
}

function eventsByKey(
  run: Run,
): Map<string, MutationEvent<AssessmentMutations>[]> {
  const events = new Map<string, MutationEvent<AssessmentMutations>[]>();
  for (const event of run.mutationEvents) {
    const key = mutationKey(event.authorization);
    events.set(key, [...(events.get(key) ?? []), event]);
  }
  return events;
}

function executionIndexesOf(
  event: BlockEvent<"fifo" | "batch", AssessmentMutations>,
) {
  const mutations =
    "mutations" in event
      ? event.mutations
      : [
          ...event.batches.flatMap((batch) => batch.mutations),
          ...event.forceIncludedMutations,
        ];
  return mutations.map((mutation) => mutation.executionIndex);
}

function compareBigInt(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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
