import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import {
  Cause,
  Chunk,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Logger,
  Queue,
  Schedule,
} from "effect";
import { EXCHANGE_ABI } from "order-book-sdk";
import type {
  Address,
  Chain,
  CreateAccessListErrorType,
  EstimateGasErrorType,
  Hex,
  PrepareTransactionRequestErrorType,
  SendRawTransactionSyncErrorType,
  SignTransactionErrorType,
} from "viem";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseSignature,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { sendRawTransactionSync } from "viem/actions";
import type * as schema from "./app-schema";
import {
  acceptMutation,
  deletePendingMutation,
  insertBlock,
  insertBundle,
  insertPendingMutation,
  selectBundleIdsInBlock,
  syncState,
  updateBundleBlock,
  updateBundleMutationStatuses,
  updateBundleMutationsBlock,
  updateBundleStatus,
} from "./db";
import type { ResolvedMutation, State, TaggedMutation } from "./exchange";
import {
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
import { resolveAndOrderMutations } from "./resolution";
import { type EIP712Domain, verifySignature } from "./signature";

export type MutationStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "proposed"
  | "voted"
  | "finalized"
  | "verified";
export type BundleStatus =
  | "accepted"
  | "proposed"
  | "voted"
  | "finalized"
  | "verified";
export type MutationEvent = ResolvedMutation & { id: number };
export type BundleEvent = {
  id: number;
  mutations: MutationEvent[];
};
type PendingBundle = {
  bundle: BundleEvent;
  proposedAt: bigint;
  status: BundleStatus;
};
export type BlockRow = { number: bigint; hash: Hex; timestamp: bigint };
export type BlockEvent = BlockRow & { bundleIds: number[] };

export type RuntimeConfig = {
  initialState: State<bigint>;
  initialMutationId?: number;
  chain: Chain;
  rpcUrl: string;
  account: PrivateKeyAccount;
  address: Address;
  rpId?: string;
  origin?: string | string[];
  db: BunSQLDatabase<typeof schema>;
};

type MutationEntry = {
  id: number;
  tagged: TaggedMutation;
  deferred: Deferred.Deferred<{ id: number } & ResolvedMutation, unknown>;
};

export type RuntimeHandle = {
  readonly state: State<bigint>;
  execute<T extends TaggedMutation>(
    mutation: T,
  ): Promise<{ id: number } & Extract<ResolvedMutation, { type: T["type"] }>>;
  on(
    event: "mutation",
    cb: (mutation: MutationEvent, status: MutationStatus) => void,
  ): void;
  on(
    event: "bundle",
    cb: (bundle: BundleEvent, status: BundleStatus) => void,
  ): void;
  on(event: "block", cb: (block: BlockEvent) => void): void;
  stream(event: "mutation"): ReadableStream;
  stream(event: "bundle"): ReadableStream;
  stream(event: "block"): ReadableStream;
  stop(): Promise<void>;
};

function encodeMutationData(resolved: ResolvedMutation): Hex {
  switch (resolved.type) {
    case MutationType.Initialize:
      return encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { type: "bytes32", name: "account" },
              { type: "uint40", name: "expiry" },
              { type: "uint8", name: "rootKeyType" },
              { type: "uint8", name: "keyType" },
              { type: "uint8", name: "permissions" },
              { type: "bytes", name: "rootPublicKey" },
              { type: "bytes", name: "publicKey" },
            ],
          },
        ],
        [
          {
            account: resolved.account,
            expiry: resolved.mutation.expiry,
            rootKeyType: resolved.mutation.rootKeyType,
            keyType: resolved.mutation.keyType,
            permissions: resolved.mutation.permissions,
            rootPublicKey: resolved.mutation.rootPublicKey,
            publicKey: resolved.mutation.publicKey,
          },
        ],
      );

    case MutationType.Authorize:
      return encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { type: "bytes32", name: "account" },
              { type: "uint40", name: "expiry" },
              { type: "uint8", name: "keyType" },
              { type: "uint8", name: "permissions" },
              { type: "bytes", name: "publicKey" },
              { type: "uint256", name: "nonce" },
              { type: "uint256", name: "deadline" },
            ],
          },
        ],
        [
          {
            account: resolved.account,
            expiry: resolved.mutation.expiry,
            keyType: resolved.mutation.keyType,
            permissions: resolved.mutation.permissions,
            publicKey: resolved.mutation.publicKey,
            nonce: resolved.nonce,
            deadline: resolved.deadline,
          },
        ],
      );

    case MutationType.Revoke:
      return encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { type: "bytes32", name: "account" },
              { type: "uint64", name: "keyId" },
              { type: "uint256", name: "nonce" },
              { type: "uint256", name: "deadline" },
            ],
          },
        ],
        [
          {
            account: resolved.account,
            keyId: BigInt(resolved.mutation.keyId),
            nonce: resolved.nonce,
            deadline: resolved.deadline,
          },
        ],
      );

    case MutationType.CloseOrder:
      return encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { type: "uint64", name: "orderId" },
              { type: "uint256", name: "nonce" },
              { type: "uint256", name: "deadline" },
            ],
          },
        ],
        [
          {
            orderId: BigInt(resolved.mutation.orderId),
            nonce: resolved.nonce,
            deadline: resolved.deadline,
          },
        ],
      );

    case MutationType.LimitOrder:
      return encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { type: "uint256", name: "quantity" },
              { type: "uint64", name: "instrumentId" },
              { type: "uint64", name: "price" },
              { type: "uint8", name: "bidOrAsk" },
              { type: "uint256", name: "nonce" },
              { type: "uint256", name: "deadline" },
            ],
          },
        ],
        [
          {
            quantity: resolved.mutation.quantity,
            instrumentId: BigInt(resolved.mutation.instrumentId),
            price: resolved.mutation.price,
            bidOrAsk: resolved.mutation.bidOrAsk,
            nonce: resolved.nonce,
            deadline: resolved.deadline,
          },
        ],
      );

    case MutationType.MarketOrder:
      return encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { type: "uint256", name: "quantity" },
              { type: "uint256", name: "minReceivedQuantity" },
              { type: "uint64", name: "instrumentId" },
              { type: "uint8", name: "bidOrAsk" },
              { type: "uint256", name: "nonce" },
              { type: "uint256", name: "deadline" },
            ],
          },
          {
            type: "tuple",
            components: [
              {
                type: "tuple[]",
                name: "fills",
                components: [
                  { type: "uint64", name: "quantity" },
                  { type: "uint64", name: "price" },
                ],
              },
            ],
          },
        ],
        [
          {
            quantity: resolved.mutation.quantity,
            minReceivedQuantity: resolved.mutation.minReceivedQuantity,
            instrumentId: BigInt(resolved.mutation.instrumentId),
            bidOrAsk: resolved.mutation.bidOrAsk,
            nonce: resolved.nonce,
            deadline: resolved.deadline,
          },
          {
            fills: resolved.resolution.fills.map((f) => ({
              quantity: f.quantity,
              price: f.price,
            })),
          },
        ],
      );

    case MutationType.AddInstrument:
      return encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { type: "uint64", name: "instrumentId" },
              { type: "address", name: "base" },
              { type: "address", name: "quote" },
              { type: "uint8", name: "baseLotExp" },
              { type: "uint8", name: "quoteLotExp" },
              { type: "uint256", name: "nonce" },
              { type: "uint256", name: "deadline" },
            ],
          },
        ],
        [
          {
            instrumentId: BigInt(resolved.mutation.instrumentId),
            base: resolved.mutation.base,
            quote: resolved.mutation.quote,
            baseLotExp: resolved.mutation.baseLotExp,
            quoteLotExp: resolved.mutation.quoteLotExp,
            nonce: resolved.nonce,
            deadline: resolved.deadline,
          },
        ],
      );

    case MutationType.Deposit:
      return encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { type: "address", name: "asset" },
              { type: "uint256", name: "amount" },
              { type: "uint256", name: "nonce" },
              { type: "uint256", name: "deadline" },
            ],
          },
        ],
        [
          {
            asset: resolved.mutation.asset,
            amount: resolved.mutation.amount,
            nonce: resolved.nonce,
            deadline: resolved.deadline,
          },
        ],
      );

    case MutationType.Withdrawal:
      return encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { type: "address", name: "asset" },
              { type: "uint256", name: "amount" },
              { type: "uint256", name: "nonce" },
              { type: "uint256", name: "deadline" },
            ],
          },
        ],
        [
          {
            asset: resolved.mutation.asset,
            amount: resolved.mutation.amount,
            nonce: resolved.nonce,
            deadline: resolved.deadline,
          },
        ],
      );
  }
}

function encodeSignature(resolved: ResolvedMutation): {
  account: Hex;
  keyId: bigint;
  rawSignature: Hex;
} {
  let { rawSignature } = resolved;

  // Compact 65-byte secp256k1 signatures need ABI re-encoding for the contract
  if (rawSignature.length === 132) {
    const { v, r, s } = parseSignature(rawSignature);
    rawSignature = encodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
      [Number(v), r, s],
    );
  }

  return {
    account: resolved.account,
    keyId: BigInt(resolved.keyId),
    rawSignature,
  };
}

function encodeBundleArg(mutations: MutationEvent[]) {
  return {
    mutations: mutations.map((m) => m.type),
    mutationData: mutations.map(encodeMutationData),
    signatures: mutations.map(encodeSignature),
  };
}

function encodeBundles(bundles: BundleEvent[]): Hex {
  return encodeFunctionData({
    abi: EXCHANGE_ABI,
    functionName: "execute",
    args: [bundles.map((b) => encodeBundleArg(b.mutations))],
  });
}

function applyMutation(state: State<bigint>, r: ResolvedMutation): void {
  switch (r.type) {
    case MutationType.Initialize:
      handleInitialize(state, r.mutation, r.account);
      break;
    case MutationType.Authorize:
      handleAuthorize(state, r.mutation, r.account);
      break;
    case MutationType.Revoke:
      handleRevoke(state, r.mutation, r.account);
      break;
    case MutationType.CloseOrder:
      handleCloseOrder(state, r.mutation, r.account);
      break;
    case MutationType.LimitOrder:
      handleLimitOrder(state, r.mutation, r.account);
      break;
    case MutationType.MarketOrder:
      handleMarketOrder(state, r.mutation, r.resolution, r.account);
      break;
    case MutationType.AddInstrument:
      handleAddInstrument(state, r.mutation);
      break;
    case MutationType.Deposit:
      handleDeposit(state, r.mutation, r.account);
      break;
    case MutationType.Withdrawal:
      handleWithdrawal(state, r.mutation, r.account);
      break;
  }
}

const BLOCK_POLLING_INTERVAL_MS = 200;
const SUBMIT_INTERVAL_MS = 400;
const BUNDLE_INTERVAL_MS = 50;

export function startRuntime(config: RuntimeConfig): RuntimeHandle {
  const state = config.initialState;
  const mutationQueue = Effect.runSync(Queue.unbounded<MutationEntry>());
  const submitQueue = Effect.runSync(Queue.unbounded<BundleEvent>());
  const pendingBundles = new Map<number, PendingBundle>();
  let nextId = config.initialMutationId ?? 0;

  const mutationListeners = new Set<
    (mutation: MutationEvent, status: MutationStatus) => void
  >();
  const bundleListeners = new Set<
    (bundle: BundleEvent, status: BundleStatus) => void
  >();
  const blockListeners = new Set<(block: BlockEvent) => void>();

  function emitMutation(mutation: MutationEvent, status: MutationStatus) {
    for (const cb of mutationListeners) {
      try {
        cb(mutation, status);
      } catch {}
    }
  }

  function emitBundle(bundle: BundleEvent, status: BundleStatus) {
    for (const cb of bundleListeners) {
      try {
        cb(bundle, status);
      } catch {}
    }
  }

  function emitBlock(block: BlockEvent) {
    for (const cb of blockListeners) {
      try {
        cb(block);
      } catch {}
    }
  }

  const transport = http(config.rpcUrl, { retryCount: 0 });

  const publicClient = createPublicClient({
    chain: config.chain,
    transport,
  });

  const walletClient = createWalletClient({
    account: config.account,
    chain: config.chain,
    transport,
  });

  let txNonce = -1;
  async function nextNonce(): Promise<number> {
    if (txNonce === -1) {
      txNonce = await publicClient.getTransactionCount({
        address: config.account.address,
        blockTag: "pending",
      });
    }
    return txNonce++;
  }

  const eip712Domain: EIP712Domain = {
    name: "Exchange",
    version: "1",
    chainId: config.chain.id,
    verifyingContract: config.address,
    rpId: config.rpId,
    origin: config.origin,
  };

  const bundle = Effect.gen(function* () {
    const batch = Chunk.toArray(yield* Queue.takeAll(mutationQueue));
    if (batch.length === 0) return;

    const rejections: { entry: MutationEntry; error: unknown }[] = [];
    let survivors = batch;
    let resolved: ResolvedMutation[] = [];

    while (survivors.length > 0) {
      resolved = resolveAndOrderMutations(
        state,
        survivors.map((e) => e.tagged),
      );
      const clone = structuredClone(state);
      let culprit: MutationEntry | null = null;
      let culpritErr: unknown;
      for (const r of resolved) {
        try {
          applyMutation(clone, r);
        } catch (err) {
          culprit = survivors.find((e) => e.tagged.mutation === r.mutation)!;
          culpritErr = err;
          break;
        }
      }
      if (culprit === null) break;
      rejections.push({ entry: culprit, error: culpritErr });
      survivors = survivors.filter((e) => e !== culprit);
    }
    if (survivors.length === 0) resolved = [];

    for (const { entry, error } of rejections) {
      yield* Effect.tryPromise({
        try: () => deletePendingMutation(config.db, entry.id),
        catch: (e) => e as Error,
      });
      yield* Deferred.fail(entry.deferred, error);
      emitMutation(
        { id: entry.id, ...entry.tagged } as MutationEvent,
        "rejected",
      );
      yield* Effect.logInfo("mutation rejected").pipe(
        Effect.annotateLogs({
          mutationId: entry.id,
          type: MutationType[entry.tagged.type],
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    const mutationEvents: MutationEvent[] = [];
    for (const r of resolved) {
      applyMutation(state, r);
      if (r.type !== MutationType.Initialize) {
        const nonceKey = BigInt(r.nonce) >> 64n;
        incrementNonce(getAccount(state, r.account), nonceKey);
      }
      const entry = survivors.find((e) => e.tagged.mutation === r.mutation)!;
      yield* Deferred.succeed(entry.deferred, { id: entry.id, ...r });
      mutationEvents.push({ id: entry.id, ...r });
    }

    if (mutationEvents.length === 0) return;

    const bundleId = yield* Effect.tryPromise({
      try: () =>
        config.db.transaction(async (tx) => {
          const id = await insertBundle(tx as unknown as typeof config.db);
          for (const m of mutationEvents) {
            const calldata = encodeMutationData(m);
            await acceptMutation(
              tx as unknown as typeof config.db,
              m,
              id,
              calldata,
            );
            await syncState(tx as unknown as typeof config.db, state, m);
          }
          return id;
        }),
      catch: (error) => error as Error,
    });

    const bundleEvent: BundleEvent = {
      id: bundleId,
      mutations: mutationEvents,
    };

    yield* Effect.logInfo("bundle accepted").pipe(
      Effect.annotateLogs({
        bundleId,
        mutations: mutationEvents.map((m) => m.id),
        mutationCount: mutationEvents.length,
      }),
    );

    for (const mutation of mutationEvents) {
      emitMutation(mutation, "accepted");
    }
    emitBundle(bundleEvent, "accepted");

    yield* Queue.offer(submitQueue, bundleEvent);
  });

  const bundleProgram = Effect.repeat(
    bundle,
    Schedule.fixed(Duration.millis(BUNDLE_INTERVAL_MS)),
  ).pipe(Effect.orDie);

  const submit = Effect.gen(function* () {
    const bundles = Chunk.toArray(yield* Queue.takeAll(submitQueue));
    if (bundles.length === 0) return;

    const rpcRetry = Effect.retry({
      times: 3,
      schedule: Schedule.spaced(Duration.millis(200)),
    });

    const args = bundles.map((b) => encodeBundleArg(b.mutations));
    const calldata = encodeBundles(bundles);

    yield* Effect.tryPromise({
      try: () =>
        publicClient.simulateContract({
          account: config.account.address,
          abi: EXCHANGE_ABI,
          address: config.address,
          functionName: "execute",
          args: [args],
        }),
      catch: (error) => error as Error,
    }).pipe(rpcRetry);

    const { accessList } = yield* Effect.tryPromise({
      try: () =>
        publicClient.createAccessList({
          account: config.account.address,
          to: config.address,
          data: calldata,
        }),
      catch: (error) => error as CreateAccessListErrorType,
    }).pipe(rpcRetry);

    const gasUsed = yield* Effect.tryPromise({
      try: () =>
        publicClient.estimateGas({
          account: config.account.address,
          to: config.address,
          data: calldata,
          accessList,
        }),
      catch: (error) => error as EstimateGasErrorType,
    }).pipe(rpcRetry);

    const nonce = yield* Effect.tryPromise({
      try: () => nextNonce(),
      catch: (error) => error as Error,
    }).pipe(rpcRetry);

    const request = yield* Effect.tryPromise({
      try: () =>
        walletClient.prepareTransactionRequest({
          to: config.address,
          data: calldata,
          accessList,
          gas: gasUsed + gasUsed / 100n,
          nonce,
        }),
      catch: (error) => error as PrepareTransactionRequestErrorType,
    }).pipe(rpcRetry);

    const signed = yield* Effect.tryPromise({
      try: () => walletClient.signTransaction(request),
      catch: (error) => error as SignTransactionErrorType,
    });

    const transactionHash = keccak256(signed);

    const receipt = yield* Effect.tryPromise({
      try: () =>
        sendRawTransactionSync(walletClient, {
          serializedTransaction: signed,
        }),
      catch: (error) => error as SendRawTransactionSyncErrorType,
    }).pipe(rpcRetry);

    if (receipt.transactionHash !== transactionHash) {
      yield* Effect.die(
        new Error(
          `transaction hash mismatch: expected ${transactionHash} got ${receipt.transactionHash}`,
        ),
      );
    }

    const block = yield* Effect.tryPromise({
      try: () => publicClient.getBlock({ blockHash: receipt.blockHash }),
      catch: (error) => error as Error,
    }).pipe(rpcRetry);

    yield* Effect.tryPromise({
      try: () =>
        config.db.transaction(async (tx) => {
          const db = tx as unknown as typeof config.db;
          await insertBlock(db, {
            number: block.number!,
            hash: block.hash as Hex,
            timestamp: block.timestamp,
          });
          for (const bundleEvent of bundles) {
            await updateBundleBlock(
              db,
              bundleEvent.id,
              receipt.blockNumber,
              transactionHash,
            );
            await updateBundleStatus(db, bundleEvent.id, "proposed");
            await updateBundleMutationsBlock(
              db,
              bundleEvent.id,
              receipt.blockNumber,
            );
            await updateBundleMutationStatuses(db, bundleEvent.id, "proposed");
          }
        }),
      catch: (error) => error as Error,
    });

    for (const bundleEvent of bundles) {
      for (const mutation of bundleEvent.mutations) {
        emitMutation(mutation, "proposed");
      }
      emitBundle(bundleEvent, "proposed");
      pendingBundles.set(bundleEvent.id, {
        bundle: bundleEvent,
        proposedAt: receipt.blockNumber,
        status: "proposed",
      });
    }

    yield* Effect.logInfo("bundles proposed").pipe(
      Effect.annotateLogs({
        bundleIds: bundles.map((b) => b.id),
        bundleCount: bundles.length,
        mutationCount: bundles.reduce((n, b) => n + b.mutations.length, 0),
        blockNumber: receipt.blockNumber.toString(),
        transactionHash,
      }),
    );
  });

  const submitProgram = Effect.repeat(
    submit,
    Schedule.fixed(Duration.millis(SUBMIT_INTERVAL_MS)),
  ).pipe(Effect.orDie);

  let lastBlockNumber = -1n;

  const watch = Effect.gen(function* () {
    const block = yield* Effect.tryPromise({
      try: () => publicClient.getBlock(),
      catch: (error) => error as Error,
    }).pipe(
      Effect.retry({
        times: 3,
        schedule: Schedule.spaced(Duration.millis(200)),
      }),
    );
    if (block.number === null || block.number <= lastBlockNumber) return;
    lastBlockNumber = block.number;

    const blockRow: BlockRow = {
      number: block.number,
      hash: block.hash as Hex,
      timestamp: block.timestamp,
    };

    const bundleIds = yield* Effect.tryPromise({
      try: () => selectBundleIdsInBlock(config.db, block.number!),
      catch: (error) => error as Error,
    });

    yield* Effect.logDebug("block").pipe(
      Effect.annotateLogs({
        number: block.number.toString(),
        hash: block.hash,
      }),
    );
    emitBlock({ ...blockRow, bundleIds });

    for (const [id, entry] of pendingBundles) {
      const confirmations = block.number - entry.proposedAt;
      let nextStatus: BundleStatus | null = null;

      if (confirmations >= 4n && entry.status !== "verified") {
        nextStatus = "verified";
      } else if (
        confirmations >= 2n &&
        entry.status !== "finalized" &&
        entry.status !== "verified"
      ) {
        nextStatus = "finalized";
      } else if (confirmations >= 1n && entry.status === "proposed") {
        nextStatus = "voted";
      }

      if (nextStatus === null) continue;

      const status = nextStatus;
      yield* Effect.tryPromise({
        try: () =>
          config.db.transaction(async (tx) => {
            const db = tx as unknown as typeof config.db;
            await updateBundleStatus(db, id, status);
            await updateBundleMutationStatuses(db, id, status);
          }),
        catch: (error) => error as Error,
      });

      for (const mutation of entry.bundle.mutations) {
        emitMutation(mutation, status as MutationStatus);
      }
      emitBundle(entry.bundle, status);
      entry.status = status;

      yield* Effect.logDebug("bundle status updated").pipe(
        Effect.annotateLogs({ bundleId: id, status }),
      );

      if (status === "verified") {
        pendingBundles.delete(id);
      }
    }
  }).pipe(Effect.withLogSpan("watch"));

  const watchProgram = Effect.repeat(
    watch,
    Schedule.spaced(Duration.millis(BLOCK_POLLING_INTERVAL_MS)),
  ).pipe(Effect.orDie);

  const runtimeEffect = Effect.gen(function* () {
    yield* Effect.logInfo("runtime started").pipe(
      Effect.annotateLogs({
        chain: config.chain.id,
        address: config.address,
      }),
    );
    yield* Effect.all([bundleProgram, submitProgram, watchProgram], {
      concurrency: "unbounded",
    });
  }).pipe(Effect.provide(Logger.json));

  const fiber = Effect.runFork(runtimeEffect);
  Effect.runPromiseExit(Fiber.join(fiber)).then((exit) => {
    if (exit._tag === "Failure" && !Cause.isInterruptedOnly(exit.cause)) {
      console.error("FATAL: runtime fiber died", Cause.pretty(exit.cause));
      process.exit(1);
    }
  });

  function execute<T extends TaggedMutation>(
    mutation: T,
  ): Promise<{ id: number } & Extract<ResolvedMutation, { type: T["type"] }>> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const typeName = MutationType[mutation.type];

        yield* Effect.logInfo("received mutation").pipe(
          Effect.annotateLogs({
            type: typeName,
            account: mutation.account,
          }),
        );

        yield* Effect.tryPromise({
          try: () => verifySignature(state, eip712Domain, mutation),
          catch: (err) => err,
        });

        const id = nextId++;
        yield* Effect.tryPromise({
          try: () => insertPendingMutation(config.db, mutation, id),
          catch: (error) => error as Error,
        });
        const deferred = yield* Deferred.make<
          { id: number } & ResolvedMutation,
          unknown
        >();
        yield* Queue.offer(mutationQueue, { id, tagged: mutation, deferred });
        emitMutation({ id, ...mutation } as MutationEvent, "pending");

        yield* Effect.logInfo("queued mutation").pipe(
          Effect.annotateLogs({
            mutationId: id,
            type: typeName,
            account: mutation.account,
          }),
        );

        return (yield* Deferred.await(deferred)) as { id: number } & Extract<
          ResolvedMutation,
          { type: T["type"] }
        >;
      }).pipe(
        Effect.tapError((error) => {
          console.error(error);
          return Effect.logError("execute failed");
        }),
        Effect.provide(Logger.json),
      ),
    );
  }

  function stop(): Promise<void> {
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logInfo("runtime stopping");
        yield* Queue.shutdown(mutationQueue);
        yield* Queue.shutdown(submitQueue);
        yield* Fiber.interrupt(fiber);
        yield* Effect.logInfo("runtime stopped");
      }).pipe(Effect.provide(Logger.json)),
    );
  }

  type MutationCb = (mutation: MutationEvent, status: MutationStatus) => void;
  type BundleCb = (bundle: BundleEvent, status: BundleStatus) => void;
  type BlockCb = (block: BlockEvent) => void;

  function on(event: "mutation", cb: MutationCb): void;
  function on(event: "bundle", cb: BundleCb): void;
  function on(event: "block", cb: BlockCb): void;
  function on(
    event: "mutation" | "bundle" | "block",
    cb: MutationCb | BundleCb | BlockCb,
  ): void {
    if (event === "mutation") mutationListeners.add(cb as MutationCb);
    else if (event === "bundle") bundleListeners.add(cb as BundleCb);
    else if (event === "block") blockListeners.add(cb as BlockCb);
  }

  function off(
    event: "mutation" | "bundle" | "block",
    cb: MutationCb | BundleCb | BlockCb,
  ): void {
    if (event === "mutation") mutationListeners.delete(cb as MutationCb);
    else if (event === "bundle") bundleListeners.delete(cb as BundleCb);
    else if (event === "block") blockListeners.delete(cb as BlockCb);
  }

  const encoder = new TextEncoder();

  function sse(event: string, data: unknown): Uint8Array {
    return encoder.encode(
      `event: ${event}\ndata: ${JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`,
    );
  }

  function stream(event: "mutation"): ReadableStream;
  function stream(event: "bundle"): ReadableStream;
  function stream(event: "block"): ReadableStream;
  function stream(event: "mutation" | "bundle" | "block"): ReadableStream {
    let cb: MutationCb | BundleCb | BlockCb;
    let keepalive: ReturnType<typeof setInterval>;
    return new ReadableStream({
      start(controller) {
        const enqueue = (chunk: Uint8Array) => {
          try {
            controller.enqueue(chunk);
          } catch {}
        };
        if (event === "mutation") {
          cb = ((mutation, status) => {
            enqueue(
              sse("mutation", { id: mutation.id, type: mutation.type, status }),
            );
          }) satisfies MutationCb;
          on("mutation", cb as MutationCb);
        } else if (event === "bundle") {
          cb = ((bundle, status) => {
            enqueue(
              sse("bundle", {
                id: bundle.id,
                status,
                mutationIds: bundle.mutations.map((m) => m.id),
              }),
            );
          }) satisfies BundleCb;
          on("bundle", cb as BundleCb);
        } else {
          cb = ((block) => {
            enqueue(
              sse("block", {
                number: block.number,
                hash: block.hash,
                timestamp: block.timestamp,
                bundleIds: block.bundleIds,
              }),
            );
          }) satisfies BlockCb;
          on("block", cb as BlockCb);
        }
        keepalive = setInterval(() => enqueue(encoder.encode(": ping\n\n")), 15000);
      },
      cancel() {
        clearInterval(keepalive);
        off(event, cb);
      },
    });
  }

  return {
    get state() {
      return state;
    },
    execute,
    on,
    stream,
    stop,
  };
}
