import { Duration, Effect, Fiber, Schedule } from "effect";
import type { Address, Chain, Hex } from "viem";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseSignature,
  recoverTypedDataAddress,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { sendRawTransactionSync } from "viem/actions";
import type { ResolvedMutation, State, TaggedMutation } from "./exchange";
import {
  getAccount,
  handleAddInstrument,
  handleCloseOrder,
  handleDeposit,
  handleLimitOrder,
  handleMarketOrder,
  handleWithdrawal,
  MutationType,
} from "./exchange";
import { resolveAndOrderMutations, resolveMarketOrder } from "./resolution";

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
  flushIntervalMs: number;
  chain: Chain;
  rpcUrl: string;
  account: PrivateKeyAccount;
  address: Address;
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

const EIP712_TYPES = {
  CloseOrder: [
    { name: "orderId", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  LimitOrder: [
    { name: "quantity", type: "uint64" },
    { name: "instrumentId", type: "uint64" },
    { name: "price", type: "uint64" },
    { name: "bidOrAsk", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  MarketOrder: [
    { name: "quantity", type: "uint64" },
    { name: "minReceivedQuantity", type: "uint64" },
    { name: "instrumentId", type: "uint64" },
    { name: "bidOrAsk", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Deposit: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Withdrawal: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "mutations", type: "uint8[]" },
          { name: "mutationData", type: "bytes[]" },
          { name: "v", type: "uint8[]" },
          { name: "r", type: "bytes32[]" },
          { name: "s", type: "bytes32[]" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

function encodeMutationData(resolved: ResolvedMutation): Hex {
  switch (resolved.type) {
    case MutationType.CloseOrder:
      return encodeAbiParameters(
        [
          { type: "uint64", name: "orderId" },
          { type: "uint256", name: "nonce" },
          { type: "uint256", name: "deadline" },
        ],
        [BigInt(resolved.mutation.orderId), resolved.nonce, resolved.deadline],
      );

    case MutationType.LimitOrder:
      return encodeAbiParameters(
        [
          { type: "uint64", name: "quantity" },
          { type: "uint64", name: "instrumentId" },
          { type: "uint64", name: "price" },
          { type: "uint8", name: "bidOrAsk" },
          { type: "uint256", name: "nonce" },
          { type: "uint256", name: "deadline" },
        ],
        [
          resolved.mutation.quantity,
          BigInt(resolved.mutation.instrumentId),
          resolved.mutation.price,
          resolved.mutation.bidOrAsk,
          resolved.nonce,
          resolved.deadline,
        ],
      );

    case MutationType.MarketOrder:
      return encodeAbiParameters(
        [
          {
            type: "tuple",
            name: "order",
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
            name: "resolution",
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
          { type: "uint64", name: "instrumentId" },
          { type: "address", name: "base" },
          { type: "address", name: "quote" },
          { type: "uint16", name: "baseLotExp" },
          { type: "uint16", name: "quoteLotExp" },
        ],
        [
          BigInt(resolved.mutation.instrumentId),
          resolved.mutation.base,
          resolved.mutation.quote,
          resolved.mutation.baseLotExp,
          resolved.mutation.quoteLotExp,
        ],
      );

    case MutationType.Deposit:
      return encodeAbiParameters(
        [
          { type: "address", name: "asset" },
          { type: "uint256", name: "amount" },
          { type: "uint256", name: "nonce" },
          { type: "uint256", name: "deadline" },
        ],
        [
          resolved.mutation.asset,
          resolved.mutation.amount,
          resolved.nonce,
          resolved.deadline,
        ],
      );

    case MutationType.Withdrawal:
      return encodeAbiParameters(
        [
          { type: "address", name: "asset" },
          { type: "uint256", name: "amount" },
          { type: "uint256", name: "nonce" },
          { type: "uint256", name: "deadline" },
        ],
        [
          resolved.mutation.asset,
          resolved.mutation.amount,
          resolved.nonce,
          resolved.deadline,
        ],
      );
  }
}

function encodeBundle(resolved: ResolvedMutation[]): Hex {
  const signatures = resolved.map((mutation) => {
    if (mutation.type === MutationType.AddInstrument) {
      return { v: 0, r: ZERO_BYTES32, s: ZERO_BYTES32 };
    }

    const { v, r, s } = parseSignature(mutation.signature);
    return { v: Number(v), r, s };
  });

  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: "execute",
    args: [
      {
        mutations: resolved.map((r) => r.type),
        mutationData: resolved.map(encodeMutationData),
        v: signatures.map((sig) => sig.v),
        r: signatures.map((sig) => sig.r),
        s: signatures.map((sig) => sig.s),
      },
    ],
  });
}

function dryRun(state: State<bigint>, mutation: TaggedMutation): void {
  const clone = structuredClone(state);

  switch (mutation.type) {
    case MutationType.CloseOrder:
      handleCloseOrder(clone, mutation.mutation, mutation.account);
      break;
    case MutationType.LimitOrder:
      handleLimitOrder(clone, mutation.mutation, mutation.account);
      break;
    case MutationType.MarketOrder: {
      const instrument = clone.instruments[mutation.mutation.instrumentId];
      if (!instrument) throw new Error("InvalidInstrument");
      const resolution = resolveMarketOrder(instrument, mutation.mutation);
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
  let nextId = 0;
  let nextBundleId = 0;

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

  const eip712Domain = {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: config.chain.id,
    verifyingContract: config.address,
  };

  async function verifySignature(mutation: TaggedMutation): Promise<void> {
    if (mutation.type === MutationType.AddInstrument) return;

    if (mutation.deadline < BigInt(Math.floor(Date.now() / 1000))) {
      throw new Error("SignatureExpired");
    }

    const acc = getAccount(state, mutation.account);
    if (mutation.nonce !== acc.nonce) {
      throw new Error("InvalidNonce");
    }

    const opts = {
      domain: eip712Domain,
      types: EIP712_TYPES,
      signature: mutation.signature,
    } as const;
    let recovered: Address;

    switch (mutation.type) {
      case MutationType.CloseOrder:
        recovered = await recoverTypedDataAddress({
          ...opts,
          primaryType: "CloseOrder",
          message: {
            orderId: BigInt(mutation.mutation.orderId),
            nonce: mutation.nonce,
            deadline: mutation.deadline,
          },
        });
        break;
      case MutationType.LimitOrder:
        recovered = await recoverTypedDataAddress({
          ...opts,
          primaryType: "LimitOrder",
          message: {
            quantity: mutation.mutation.quantity,
            instrumentId: BigInt(mutation.mutation.instrumentId),
            price: mutation.mutation.price,
            bidOrAsk: mutation.mutation.bidOrAsk,
            nonce: mutation.nonce,
            deadline: mutation.deadline,
          },
        });
        break;
      case MutationType.MarketOrder:
        recovered = await recoverTypedDataAddress({
          ...opts,
          primaryType: "MarketOrder",
          message: {
            quantity: mutation.mutation.quantity,
            minReceivedQuantity: mutation.mutation.minReceivedQuantity,
            instrumentId: BigInt(mutation.mutation.instrumentId),
            bidOrAsk: mutation.mutation.bidOrAsk,
            nonce: mutation.nonce,
            deadline: mutation.deadline,
          },
        });
        break;
      case MutationType.Deposit:
        recovered = await recoverTypedDataAddress({
          ...opts,
          primaryType: "Deposit",
          message: {
            asset: mutation.mutation.asset,
            amount: mutation.mutation.amount,
            nonce: mutation.nonce,
            deadline: mutation.deadline,
          },
        });
        break;
      case MutationType.Withdrawal:
        recovered = await recoverTypedDataAddress({
          ...opts,
          primaryType: "Withdrawal",
          message: {
            asset: mutation.mutation.asset,
            amount: mutation.mutation.amount,
            nonce: mutation.nonce,
            deadline: mutation.deadline,
          },
        });
        break;
    }

    if (recovered.toLowerCase() !== mutation.account.toLowerCase()) {
      throw new Error("InvalidSignature");
    }
  }

  const flushOnce = Effect.gen(function* () {
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

    const { accessList, gasUsed } = yield* Effect.promise(() =>
      publicClient.createAccessList({
        account: config.account.address,
        to: config.address,
        data: bundle.calldata,
      }),
    );

    const request = yield* Effect.promise(() =>
      walletClient.prepareTransactionRequest({
        to: config.address,
        data: bundle.calldata,
        accessList,
        gas: gasUsed + gasUsed / 10n,
      }),
    );

    const signed = yield* Effect.promise(() =>
      walletClient.signTransaction(request),
    );

    const receipt = yield* Effect.promise(() =>
      sendRawTransactionSync(walletClient, {
        serializedTransaction: signed,
      }),
    );

    for (const mutation of mutationEvents) {
      emitMutation(mutation, "proposed");
    }
    emitBundle(bundle, "proposed");

    yield* Effect.logInfo("bundle proposed").pipe(
      Effect.annotateLogs({
        bundleId: bundle.id,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
      }),
    );

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
  });

  const program = Effect.repeat(
    flushOnce,
    Schedule.spaced(Duration.millis(config.flushIntervalMs)),
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
    Schedule.spaced(Duration.millis(50)),
  );

  const fiber = Effect.runFork(program);
  const blockFiber = Effect.runFork(blockProgram);

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
      await verifySignature(mutation);
      dryRun(state, mutation);
    } catch (err) {
      Effect.runSync(
        Effect.logWarning("mutation rejected").pipe(
          Effect.annotateLogs({
            type: typeName,
            account: account ?? "n/a",
            error: String(err),
          }),
        ),
      );
      throw err;
    }

    if (mutation.type !== MutationType.AddInstrument) {
      getAccount(state, mutation.account).nonce++;
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
