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
export type BlockStatus =
  | "accepted"
  | "proposed"
  | "voted"
  | "finalized"
  | "verified";

type ResolvedMutationEvent = {
  id: number;
  status: Exclude<MutationStatus, "pending" | "rejected">;
} & ResolvedMutation;
export type MutationEvent =
  | ({ id: number; status: "pending" | "rejected" } & TaggedMutation)
  | ResolvedMutationEvent;

export type BundleEvent<includeMutations extends boolean = false> = {
  id: number;
  status: BundleStatus;
  position: number;
  mutations: includeMutations extends true ? ResolvedMutationEvent[] : number[];
};

export type BlockEvent<includeMutations extends boolean = false> =
  | {
      status: "accepted";
      bundles: includeMutations extends true ? BundleEvent<true>[] : number[];
    }
  | {
      status: Exclude<BlockStatus, "accepted">;
      number: bigint;
      hash: Hex;
      timestamp: bigint;
      bundles: includeMutations extends true ? BundleEvent<true>[] : number[];
    };

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

export type RuntimeHandle = {
  readonly state: State<bigint>;
  execute<T extends TaggedMutation>(
    mutation: T,
  ): Promise<{ id: number } & Extract<ResolvedMutation, { type: T["type"] }>>;
  on(event: "mutation", cb: (mutation: MutationEvent) => void): void;
  on(event: "bundle", cb: (bundle: BundleEvent<true>) => void): void;
  on(event: "block", cb: (block: BlockEvent<true>) => void): void;
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

function toStreamMutation(m: ResolvedMutationEvent) {
  const base = {
    id: m.id,
    account: m.account,
    keyIndex: m.type === MutationType.Initialize ? null : m.keyId,
    nonce: m.type === MutationType.Initialize ? null : m.nonce,
    deadline: m.deadline,
  };
  switch (m.type) {
    case MutationType.Initialize:
      return {
        ...base,
        type: "initialize" as const,
        payload: {
          id: m.id,
          expiry: m.mutation.expiry,
          rootKeyType: m.mutation.rootKeyType,
          keyType: m.mutation.keyType,
          permissions: m.mutation.permissions,
          rootPublicKey: m.mutation.rootPublicKey,
          publicKey: m.mutation.publicKey,
        },
      };
    case MutationType.Authorize:
      return {
        ...base,
        type: "authorize" as const,
        payload: {
          id: m.id,
          expiry: m.mutation.expiry,
          keyType: m.mutation.keyType,
          permissions: m.mutation.permissions,
          publicKey: m.mutation.publicKey,
        },
      };
    case MutationType.Revoke:
      return {
        ...base,
        type: "revoke" as const,
        payload: { id: m.id, revokedKeyId: m.mutation.keyId },
      };
    case MutationType.CloseOrder:
      return {
        ...base,
        type: "closeOrder" as const,
        payload: { id: m.id, orderId: m.mutation.orderId },
      };
    case MutationType.LimitOrder:
      return {
        ...base,
        type: "limitOrder" as const,
        payload: {
          id: m.id,
          quantity: m.mutation.quantity,
          instrumentId: m.mutation.instrumentId,
          price: m.mutation.price,
          bidOrAsk: m.mutation.bidOrAsk,
        },
      };
    case MutationType.MarketOrder:
      return {
        ...base,
        type: "marketOrder" as const,
        payload: {
          id: m.id,
          quantity: m.mutation.quantity,
          minReceivedQuantity: m.mutation.minReceivedQuantity,
          instrumentId: m.mutation.instrumentId,
          bidOrAsk: m.mutation.bidOrAsk,
          fills: m.resolution.fills.map((f) => ({
            quantity: f.quantity,
            price: f.price,
          })),
        },
      };
    case MutationType.AddInstrument:
      return {
        ...base,
        type: "addInstrument" as const,
        payload: {
          id: m.id,
          instrumentId: m.mutation.instrumentId,
          base: m.mutation.base,
          quote: m.mutation.quote,
          baseLotExp: m.mutation.baseLotExp,
          quoteLotExp: m.mutation.quoteLotExp,
        },
      };
    case MutationType.Deposit:
      return {
        ...base,
        type: "deposit" as const,
        payload: {
          id: m.id,
          asset: m.mutation.asset,
          amount: m.mutation.amount,
        },
      };
    case MutationType.Withdrawal:
      return {
        ...base,
        type: "withdrawal" as const,
        payload: {
          id: m.id,
          asset: m.mutation.asset,
          amount: m.mutation.amount,
        },
      };
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

function encodeBundleArg(mutations: ResolvedMutationEvent[]) {
  return {
    mutations: mutations.map((m) => m.type),
    mutationData: mutations.map(encodeMutationData),
    signatures: mutations.map(encodeSignature),
  };
}

function encodeBundles(bundles: BundleEvent<true>[]): Hex {
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
  const mutationQueue = Effect.runSync(
    Queue.unbounded<
      Extract<MutationEvent, { status: "pending" | "rejected" }> & {
        deferred: Deferred.Deferred<MutationEvent, unknown>;
      }
    >(),
  );
  const submitQueue = Effect.runSync(Queue.unbounded<BundleEvent<true>>());
  let unverifiedBlocks: Extract<
    BlockEvent<true>,
    { status: Exclude<BlockStatus, "accepted"> }
  >[] = [];

  let nextId = config.initialMutationId ?? 0;
  let bundlePosition = 0;

  const mutationListeners = new Set<(mutation: MutationEvent) => void>();
  const bundleListeners = new Set<(bundle: BundleEvent<true>) => void>();
  const blockListeners = new Set<(block: BlockEvent<true>) => void>();

  function emitMutation(mutation: MutationEvent) {
    for (const cb of mutationListeners) {
      try {
        cb(mutation);
      } catch {}
    }
  }

  function emitBundle(bundle: BundleEvent<true>) {
    for (const cb of bundleListeners) {
      try {
        cb(bundle);
      } catch {}
    }
  }

  function emitBlock(block: BlockEvent<true>) {
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
    const position = bundlePosition++;

    const queued = Chunk.toArray(yield* Queue.takeAll(mutationQueue));
    const deferredById = new Map(queued.map((m) => [m.id, m.deferred]));
    let mutations = queued as Extract<
      MutationEvent,
      { status: "pending" | "rejected" }
    >[];
    let resolvedMutations: ResolvedMutationEvent[] = [];
    const rejections: {
      mutation: Extract<MutationEvent, { status: "pending" | "rejected" }>;
      error: unknown;
    }[] = [];

    if (mutations.length === 0) return;

    while (mutations.length > 0) {
      // @ts-ignore hack because ids are passed through
      resolvedMutations = resolveAndOrderMutations(state, mutations);
      const clone = structuredClone(state);
      let failedMutation: MutationEvent | null = null;
      let error: unknown;
      for (const resolvedMutation of resolvedMutations) {
        try {
          applyMutation(clone, resolvedMutation);
        } catch (_error) {
          failedMutation = resolvedMutation;
          resolvedMutations = resolvedMutations.filter(
            (m) => m.id !== resolvedMutation.id,
          );
          mutations = mutations.filter((m) => m.id !== resolvedMutation.id);
          error = _error;
          break;
        }
      }
      if (failedMutation === null) break;
      // @ts-ignore
      rejections.push({ mutation: failedMutation, error });
    }

    // state, status, deferred, db, emit

    for (const mutation of resolvedMutations) {
      applyMutation(state, mutation);
      if (mutation.type !== MutationType.Initialize) {
        const nonceKey = BigInt(mutation.nonce) >> 64n;
        incrementNonce(getAccount(state, mutation.account), nonceKey);
      }
    }

    for (const { mutation } of rejections) {
      mutation.status = "rejected";
    }

    for (const mutation of resolvedMutations) {
      mutation.status = "accepted";
    }

    for (const { mutation, error } of rejections) {
      yield* Deferred.fail(deferredById.get(mutation.id)!, error);

      yield* Effect.logInfo("mutation rejected").pipe(
        Effect.annotateLogs({
          mutationId: mutation.id,
          type: MutationType[mutation.type],
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    for (const mutation of resolvedMutations) {
      yield* Deferred.succeed(deferredById.get(mutation.id)!, mutation);
    }

    for (const { mutation } of rejections) {
      yield* Effect.tryPromise({
        try: () => deletePendingMutation(config.db, mutation.id),
        catch: (e) => e as Error,
      });
    }

    const bundleId = yield* Effect.tryPromise({
      try: () =>
        config.db.transaction(async (tx) => {
          const bundleId = await insertBundle(
            tx as unknown as typeof config.db,
          );
          for (const mutation of resolvedMutations) {
            const calldata = encodeMutationData(mutation);
            await acceptMutation(
              tx as unknown as typeof config.db,
              mutation,
              bundleId,
              calldata,
            );
            await syncState(tx as unknown as typeof config.db, state, mutation);
          }
          return bundleId;
        }),
      catch: (error) => error as Error,
    });

    emitBundle({
      id: bundleId,
      status: "accepted",
      position,
      mutations: resolvedMutations,
    });

    for (const { mutation } of rejections) {
      emitMutation(mutation);
    }

    for (const mutation of resolvedMutations) {
      emitMutation(mutation);
    }

    yield* Effect.logInfo("bundle accepted").pipe(
      Effect.annotateLogs({
        bundleId,
        position,
        mutations: resolvedMutations.map((m) => m.id),
        mutationCount: resolvedMutations.length,
      }),
    );

    yield* Queue.offer(submitQueue, {
      id: bundleId,
      status: "accepted",
      position,
      mutations: resolvedMutations,
    });
  });

  const bundleProgram = Effect.repeat(
    bundle,
    Schedule.fixed(Duration.millis(BUNDLE_INTERVAL_MS)),
  ).pipe(Effect.orDie);

  const submit = Effect.gen(function* () {
    bundlePosition = 0;

    const bundles = Chunk.toArray(yield* Queue.takeAll(submitQueue));
    if (bundles.length === 0) return;

    emitBlock({ status: "accepted", bundles });

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

    const block = yield* Effect.tryPromise({
      try: () => publicClient.getBlock({ blockHash: receipt.blockHash }),
      catch: (error) => error as Error,
    }).pipe(rpcRetry);

    for (const bundle of bundles) {
      for (const mutation of bundle.mutations) {
        mutation.status = "proposed";
      }
      bundle.status = "proposed";
    }

    yield* Effect.tryPromise({
      try: () =>
        config.db.transaction(async (tx) => {
          const db = tx as unknown as typeof config.db;
          await insertBlock(db, {
            number: block.number,
            hash: block.hash,
            timestamp: block.timestamp,
          });
          for (const bundleEvent of bundles) {
            await updateBundleBlock(
              db,
              bundleEvent.id,
              block.number,
              transactionHash,
            );
            await updateBundleStatus(db, bundleEvent.id, "proposed");
            await updateBundleMutationsBlock(db, bundleEvent.id, block.number);
            await updateBundleMutationStatuses(db, bundleEvent.id, "proposed");
          }
        }),
      catch: (error) => error as Error,
    });

    emitBlock({
      status: "proposed",
      bundles,
      number: block.number,
      hash: block.hash,
      timestamp: block.timestamp,
    });

    for (const bundle of bundles) {
      emitBundle(bundle);
      for (const mutation of bundle.mutations) {
        emitMutation(mutation);
      }
    }

    unverifiedBlocks.push({
      status: "proposed",
      bundles,
      number: block.number,
      hash: block.hash,
      timestamp: block.timestamp,
    });

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

    for (const blockEvent of unverifiedBlocks.filter(
      (b) => b.number < block.number,
    )) {
      const confirmations = block.number - blockEvent.number;
      let isStatusUpdated = false;

      if (confirmations >= 5n && blockEvent.status !== "verified") {
        blockEvent.status = "verified";
        isStatusUpdated = true;
      } else if (
        confirmations >= 2n &&
        blockEvent.status !== "finalized" &&
        blockEvent.status !== "verified"
      ) {
        blockEvent.status = "finalized";
        isStatusUpdated = true;
      } else if (
        confirmations >= 1n &&
        blockEvent.status !== "voted" &&
        blockEvent.status !== "finalized" &&
        blockEvent.status !== "verified"
      ) {
        blockEvent.status = "voted";
        isStatusUpdated = true;
      }

      if (isStatusUpdated === false) continue;

      for (const bundle of blockEvent.bundles) {
        for (const mutation of bundle.mutations) {
          mutation.status = blockEvent.status;
        }
        bundle.status = blockEvent.status;
      }

      yield* Effect.tryPromise({
        try: () =>
          config.db.transaction(async (tx) => {
            const db = tx as unknown as typeof config.db;
            for (const bundle of blockEvent.bundles) {
              await updateBundleStatus(db, bundle.id, bundle.status);
              await updateBundleMutationStatuses(db, bundle.id, bundle.status);
            }
          }),
        catch: (error) => error as Error,
      });

      emitBlock({
        status: blockEvent.status,
        bundles: blockEvent.bundles,
        number: blockEvent.number,
        hash: blockEvent.hash,
        timestamp: blockEvent.timestamp,
      });

      for (const bundle of blockEvent.bundles) {
        emitBundle(bundle);
        for (const mutation of bundle.mutations) {
          emitMutation(mutation);
        }
      }
    }

    unverifiedBlocks = unverifiedBlocks.filter((b) => b.status !== "verified");
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
        const deferred = yield* Deferred.make<MutationEvent, unknown>();
        yield* Queue.offer(mutationQueue, {
          id,
          status: "pending",
          ...mutation,
          deferred,
        });
        emitMutation({ id, status: "pending", ...mutation });

        yield* Effect.logInfo("queued mutation").pipe(
          Effect.annotateLogs({
            mutationId: id,
            type: typeName,
            account: mutation.account,
          }),
        );

        return (yield* Deferred.await(deferred)) as unknown as {
          id: number;
        } & Extract<ResolvedMutation, { type: T["type"] }>;
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

  type MutationCb = (mutation: MutationEvent) => void;
  type BundleCb = (bundle: BundleEvent<true>) => void;
  type BlockCb = (block: BlockEvent<true>) => void;

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
          cb = ((mutation) => {
            enqueue(
              sse("mutation", {
                id: mutation.id,
                type: mutation.type,
                status: mutation.status,
              }),
            );
          }) satisfies MutationCb;
          on("mutation", cb as MutationCb);
        } else if (event === "bundle") {
          cb = ((bundle) => {
            enqueue(
              sse("bundle", {
                id: bundle.id,
                status: bundle.status,
                position: bundle.position,
                mutations: bundle.mutations.map(toStreamMutation),
              }),
            );
          }) satisfies BundleCb;
          on("bundle", cb as BundleCb);
        } else {
          cb = ((block) => {
            const payload =
              block.status === "accepted"
                ? {
                    status: block.status,
                    bundles: block.bundles.map((b) => b.id),
                  }
                : {
                    status: block.status,
                    number: block.number,
                    hash: block.hash,
                    timestamp: block.timestamp,
                    bundles: block.bundles.map((b) => ({
                      id: b.id,
                      position: b.position,
                      mutationCount: b.mutations.length,
                    })),
                  };
            enqueue(sse("block", payload));
          }) satisfies BlockCb;
          on("block", cb as BlockCb);
        }
        keepalive = setInterval(
          () => enqueue(encoder.encode(": ping\n\n")),
          15000,
        );
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
