import {
  Chunk,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Logger,
  Queue,
  Schedule,
} from "effect";
import type {
  Address,
  Chain,
  CreateAccessListErrorType,
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
  parseSignature,
  zeroHash,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { sendRawTransactionSync } from "viem/actions";
import { EXCHANGE_ABI } from "./constants";
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
import { resolveAndOrderMutations, resolveMarketOrder } from "./resolution";
import { type EIP712Domain, verifySignature } from "./signature";

export type MutationStatus =
  | "queued"
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
  calldata: Hex;
  mutations: MutationEvent[];
};
export type BlockEvent = { number: bigint; hash: Hex; timestamp: bigint };

export type RuntimeConfig = {
  initialState: State<bigint>;
  initialMutationId?: number;
  initialBundleId?: number;
  flushIntervalMs: number;
  chain: Chain;
  rpcUrl: string;
  account: PrivateKeyAccount;
  address: Address;
  rpId?: string;
  origin?: string | string[];
};

type QueueEntry = {
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
              { type: "uint64", name: "quantity" },
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
              { type: "uint64", name: "quantity" },
              { type: "uint64", name: "minReceivedQuantity" },
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
              { type: "uint16", name: "baseLotExp" },
              { type: "uint16", name: "quoteLotExp" },
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
  if (resolved.type === MutationType.AddInstrument) {
    return { account: zeroHash, keyId: 0n, rawSignature: "0x" };
  }

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

function encodeBundle(resolved: ResolvedMutation[]): Hex {
  return encodeFunctionData({
    abi: EXCHANGE_ABI,
    functionName: "execute",
    args: [
      {
        mutations: resolved.map((r) => r.type),
        mutationData: resolved.map(encodeMutationData),
        signatures: resolved.map(encodeSignature),
      },
    ],
  });
}

function dryRun(state: State<bigint>, mutation: TaggedMutation): void {
  const clone = structuredClone(state);

  switch (mutation.type) {
    case MutationType.Initialize:
      handleInitialize(clone, mutation.mutation, mutation.account);
      break;
    case MutationType.Authorize:
      handleAuthorize(clone, mutation.mutation, mutation.account);
      break;
    case MutationType.Revoke:
      handleRevoke(clone, mutation.mutation, mutation.account);
      break;
    case MutationType.CloseOrder:
      handleCloseOrder(clone, mutation.mutation, mutation.account);
      break;
    case MutationType.LimitOrder:
      handleLimitOrder(clone, mutation.mutation, mutation.account);
      break;
    case MutationType.MarketOrder: {
      const instrument = clone.instruments[mutation.mutation.instrumentId];
      if (!instrument)
        throw new Error(
          `InvalidInstrument: instrumentId=${mutation.mutation.instrumentId}, account=${mutation.account}`,
        );
      const resolution = resolveMarketOrder(
        instrument,
        mutation.mutation,
        new Map(),
      );
      handleMarketOrder(clone, mutation.mutation, resolution, mutation.account);
      break;
    }
    case MutationType.AddInstrument:
      handleAddInstrument(clone, mutation.mutation);
      break;
    case MutationType.Deposit:
      handleDeposit(clone, mutation.mutation, mutation.account);
      break;
    case MutationType.Withdrawal:
      handleWithdrawal(clone, mutation.mutation, mutation.account);
      break;
  }
}

export function startRuntime(config: RuntimeConfig): RuntimeHandle {
  const state = config.initialState;
  const queue = Effect.runSync(Queue.unbounded<QueueEntry>());
  let nextId = config.initialMutationId ?? 0;
  let nextBundleId = config.initialBundleId ?? 0;

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

  const flush = Effect.gen(function* () {
    const batch = Chunk.toArray(yield* Queue.takeAll(queue));
    if (batch.length === 0) return;
    const mutationEvents: MutationEvent[] = [];

    const resolved = resolveAndOrderMutations(
      state,
      batch.map((e) => e.tagged),
    );

    for (const r of resolved) {
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

      const entry = batch.find((e) => e.tagged.mutation === r.mutation);
      if (entry) {
        yield* Deferred.succeed(entry.deferred, { id: entry.id, ...r });
        mutationEvents.push({ id: entry.id, ...r });
      }
    }

    const calldata = encodeBundle(resolved);
    const bundleId = nextBundleId++;
    const bundle: BundleEvent = {
      id: bundleId,
      calldata,
      mutations: mutationEvents,
    };

    yield* Effect.logInfo("bundle accepted").pipe(
      Effect.annotateLogs({
        bundleId,
        mutations: mutationEvents.map((m) => m.id),
        mutationCount: mutationEvents.length,
      }),
    );

    emitBundle(bundle, "accepted");

    const { accessList, gasUsed } = yield* Effect.tryPromise({
      try: () =>
        publicClient.createAccessList({
          account: config.account.address,
          to: config.address,
          data: bundle.calldata,
        }),
      catch: (error) => error as CreateAccessListErrorType,
    });

    const nonce = yield* Effect.tryPromise({
      try: () => nextNonce(),
      catch: (error) => error as Error,
    });

    const request = yield* Effect.tryPromise({
      try: () =>
        walletClient.prepareTransactionRequest({
          to: config.address,
          data: bundle.calldata,
          accessList,
          gas: gasUsed + gasUsed / 10n,
          nonce,
        }),
      catch: (error) => error as PrepareTransactionRequestErrorType,
    });

    const signed = yield* Effect.tryPromise({
      try: () => walletClient.signTransaction(request),
      catch: (error) => error as SignTransactionErrorType,
    });

    const receipt = yield* Effect.tryPromise({
      try: () =>
        sendRawTransactionSync(walletClient, {
          serializedTransaction: signed,
        }),
      catch: (error) => error as SendRawTransactionSyncErrorType,
    });

    for (const mutation of mutationEvents) {
      emitMutation(mutation, "proposed");
    }
    emitBundle(bundle, "proposed");

    yield* Effect.logInfo("bundle proposed").pipe(
      Effect.annotateLogs({
        bundleId,
        mutations: mutationEvents.map((m) => m.id),
        mutationCount: mutationEvents.length,
        blockNumber: receipt.blockNumber.toString(),
        transactionHash: receipt.transactionHash,
      }),
    );

    yield* Effect.fork(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(400));
        for (const mutation of mutationEvents) emitMutation(mutation, "voted");
        emitBundle(bundle, "voted");

        yield* Effect.logDebug("bundle status updated").pipe(
          Effect.annotateLogs({ bundleId: bundle.id, status: "voted" }),
        );

        yield* Effect.sleep(Duration.millis(400));
        for (const mutation of mutationEvents) {
          emitMutation(mutation, "finalized");
        }
        emitBundle(bundle, "finalized");

        yield* Effect.logDebug("bundle status updated").pipe(
          Effect.annotateLogs({ bundleId: bundle.id, status: "finalized" }),
        );

        yield* Effect.sleep(Duration.millis(1200));
        for (const mutation of mutationEvents) {
          emitMutation(mutation, "verified");
        }
        emitBundle(bundle, "verified");

        yield* Effect.logInfo("bundle status updated").pipe(
          Effect.annotateLogs({ bundleId: bundle.id, status: "verified" }),
        );
      }),
    );
  }).pipe(Effect.withLogSpan("flush"));

  const program = Effect.repeat(
    flush.pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const remaining = Chunk.toArray(yield* Queue.takeAll(queue));
          for (const entry of remaining) {
            yield* Deferred.fail(entry.deferred, error);
          }
          yield* Effect.logError("flush failed").pipe(
            Effect.annotateLogs({
              droppedMutations: remaining.map((e) => e.id),
              droppedMutationCount: remaining.length,
            }),
          );
          console.error(error);
        }),
      ),
    ),
    Schedule.fixed(Duration.millis(config.flushIntervalMs)),
  );

  let lastBlockNumber = -1n;

  const blockPoller = Effect.gen(function* () {
    const block = yield* Effect.promise(() => publicClient.getBlock());
    if (block.number !== null && block.number > lastBlockNumber) {
      lastBlockNumber = block.number;
      yield* Effect.logDebug("block").pipe(
        Effect.annotateLogs({
          number: block.number.toString(),
          hash: block.hash,
        }),
      );
      emitBlock({
        number: block.number,
        hash: block.hash as Hex,
        timestamp: block.timestamp,
      });
    }
  });

  const blockProgram = Effect.repeat(
    blockPoller,
    Schedule.spaced(Duration.millis(500)),
  );

  const fiber = Effect.runFork(
    Effect.gen(function* () {
      yield* Effect.logInfo("runtime started").pipe(
        Effect.annotateLogs({
          chain: config.chain.id,
          address: config.address,
          flushIntervalMs: config.flushIntervalMs,
        }),
      );
      yield* Effect.all([program, blockProgram], { concurrency: "unbounded" });
    }).pipe(Effect.provide(Logger.json)),
  );

  function execute<T extends TaggedMutation>(
    mutation: T,
  ): Promise<{ id: number } & Extract<ResolvedMutation, { type: T["type"] }>> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const typeName = MutationType[mutation.type];
        const account =
          mutation.type !== MutationType.AddInstrument
            ? mutation.account
            : undefined;

        yield* Effect.logInfo("received mutation").pipe(
          Effect.annotateLogs({
            type: typeName,
            account: account ?? "n/a",
          }),
        );

        yield* Effect.tryPromise({
          try: () => verifySignature(state, eip712Domain, mutation),
          catch: (err) => err,
        });
        yield* Effect.try({
          try: () => dryRun(state, mutation),
          catch: (err) => err,
        });

        if (
          mutation.type !== MutationType.AddInstrument &&
          mutation.type !== MutationType.Initialize
        ) {
          const nonceKey = BigInt(mutation.nonce) >> 64n;
          incrementNonce(getAccount(state, mutation.account), nonceKey);
        }

        const id = nextId++;
        const deferred = yield* Deferred.make<
          { id: number } & ResolvedMutation,
          unknown
        >();
        yield* Queue.offer(queue, { id, tagged: mutation, deferred });
        emitMutation({ id, ...mutation } as MutationEvent, "queued");

        yield* Effect.logInfo("queued mutation").pipe(
          Effect.annotateLogs({
            mutationId: id,
            type: typeName,
            account: account ?? "n/a",
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
        yield* Queue.shutdown(queue);
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
    return new ReadableStream({
      start(controller) {
        if (event === "mutation") {
          on("mutation", (mutation, status) => {
            controller.enqueue(
              sse("mutation", { id: mutation.id, type: mutation.type, status }),
            );
          });
        } else if (event === "bundle") {
          on("bundle", (bundle, status) => {
            controller.enqueue(
              sse("bundle", {
                id: bundle.id,
                status,
                mutationIds: bundle.mutations.map((m) => m.id),
              }),
            );
          });
        } else if (event === "block") {
          on("block", (block) => {
            controller.enqueue(
              sse("block", {
                number: block.number,
                hash: block.hash,
                timestamp: block.timestamp,
              }),
            );
          });
        }
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
