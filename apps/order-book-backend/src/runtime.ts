import { Duration, Effect, Fiber, Logger, LogLevel, Schedule } from "effect";
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
  resolve: ((resolved: { id: number } & ResolvedMutation) => void) | null;
};

export type RuntimeHandle = {
  readonly state: State<bigint>;
  readonly queue: (TaggedMutation & { id: number })[];
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
      if (!instrument) throw new Error("InvalidInstrument");
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
  const queue: QueueEntry[] = [];
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

  const eip712Domain: EIP712Domain = {
    name: "Exchange",
    version: "1",
    chainId: config.chain.id,
    verifyingContract: config.address,
    rpId: config.rpId,
    origin: config.origin,
  };

  const flush = Effect.gen(function* () {
    if (queue.length === 0) return;

    const batch = queue.splice(0);
    yield* Effect.logDebug("flush").pipe(
      Effect.annotateLogs({ batchSize: batch.length }),
    );
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
        entry.resolve?.({ id: entry.id, ...r });
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

    yield* Effect.logInfo("bundle created").pipe(
      Effect.annotateLogs({
        bundleId,
        mutations: mutationEvents.length,
        calldataBytes: calldata.length / 2 - 1,
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

    const request = yield* Effect.tryPromise({
      try: () =>
        walletClient.prepareTransactionRequest({
          to: config.address,
          data: bundle.calldata,
          accessList,
          gas: gasUsed + gasUsed / 10n,
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
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
      }),
    );

    yield* Effect.fork(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(400));
        for (const mutation of mutationEvents) emitMutation(mutation, "voted");
        emitBundle(bundle, "voted");

        yield* Effect.logDebug("bundle status").pipe(
          Effect.annotateLogs({ bundleId: bundle.id, status: "voted" }),
        );

        yield* Effect.sleep(Duration.millis(400));
        for (const mutation of mutationEvents) {
          emitMutation(mutation, "finalized");
        }
        emitBundle(bundle, "finalized");

        yield* Effect.logDebug("bundle status").pipe(
          Effect.annotateLogs({ bundleId: bundle.id, status: "finalized" }),
        );

        yield* Effect.sleep(Duration.millis(1200));
        for (const mutation of mutationEvents) {
          emitMutation(mutation, "verified");
        }
        emitBundle(bundle, "verified");

        yield* Effect.logInfo("bundle verified").pipe(
          Effect.annotateLogs({
            bundleId: bundle.id,
            transactionHash: receipt.transactionHash,
          }),
        );
      }),
    );
  });

  const program = Effect.repeat(
    flush.pipe(Effect.tapError((error) => Effect.logError(error))),
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
    program.pipe(Logger.withMinimumLogLevel(LogLevel.Debug)),
  );
  const blockFiber = Effect.runFork(
    blockProgram.pipe(Logger.withMinimumLogLevel(LogLevel.Debug)),
  );

  Effect.runSync(
    Effect.logInfo("runtime started").pipe(
      Effect.annotateLogs({
        chain: config.chain.id,
        address: config.address,
        flushIntervalMs: config.flushIntervalMs,
      }),
    ),
  );

  async function execute<T extends TaggedMutation>(
    mutation: T,
  ): Promise<{ id: number } & Extract<ResolvedMutation, { type: T["type"] }>> {
    const typeName = MutationType[mutation.type];
    const account =
      mutation.type !== MutationType.AddInstrument
        ? mutation.account
        : undefined;

    try {
      await verifySignature(state, eip712Domain, mutation);
      dryRun(state, mutation);
    } catch (err) {
      Effect.runSync(Effect.logError(err));
      throw err;
    }

    if (
      mutation.type !== MutationType.AddInstrument &&
      mutation.type !== MutationType.Initialize
    ) {
      const nonceKey = BigInt(mutation.nonce) >> 64n;
      incrementNonce(getAccount(state, mutation.account), nonceKey);
    }

    const id = nextId++;
    const { promise, resolve } = Promise.withResolvers<
      { id: number } & Extract<ResolvedMutation, { type: T["type"] }>
    >();
    queue.push({
      id,
      tagged: mutation,
      resolve: resolve as (resolved: { id: number } & ResolvedMutation) => void,
    });
    emitMutation({ id, ...mutation } as MutationEvent, "queued");

    Effect.runSync(
      Effect.logInfo("mutation queued").pipe(
        Effect.annotateLogs({
          mutationId: id,
          type: typeName,
          account: account ?? "n/a",
        }),
      ),
    );

    return promise;
  }

  async function stop(): Promise<void> {
    Effect.runSync(Effect.logInfo("runtime stopping"));
    await Effect.runPromise(Fiber.interrupt(blockFiber));
    await Effect.runPromise(Fiber.interrupt(fiber));
    Effect.runSync(Effect.logInfo("runtime stopped"));
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
    get queue() {
      return queue.map((e) => ({ id: e.id, ...e.tagged }));
    },
    execute,
    on,
    stream,
    stop,
  };
}
