import { Duration, Effect, Fiber, Schedule } from "effect";
import * as P256 from "ox/P256";
import * as PublicKey from "ox/PublicKey";
import * as WebAuthnP256 from "ox/WebAuthnP256";
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
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  http,
  parseSignature,
  recoverTypedDataAddress,
  zeroHash,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { sendRawTransactionSync } from "viem/actions";
import { EIP712_TYPES, EXCHANGE_ABI } from "./constants";
import type {
  Key,
  KeyType,
  ResolvedMutation,
  State,
  TaggedMutation,
} from "./exchange";
import {
  getAccount,
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
  incrementNonce,
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
  rpId: string;
  origin: string | string[];
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

export type EIP712Domain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
  rpId: string;
  origin: string | string[];
};

type SignedMutation = Exclude<
  TaggedMutation,
  { type: MutationType.AddInstrument }
>;

export function getTypedDataParams(mutation: SignedMutation): {
  primaryType: string;
  message: Record<string, unknown>;
} {
  switch (mutation.type) {
    case MutationType.Initialize:
      return {
        primaryType: "Initialize",
        message: {
          account: mutation.account,
          expiry: mutation.mutation.expiry,
          rootKeyType: mutation.mutation.rootKeyType,
          keyType: mutation.mutation.keyType,
          permissions: mutation.mutation.permissions,
          rootPublicKey: mutation.mutation.rootPublicKey,
          publicKey: mutation.mutation.publicKey,
        },
      };
    case MutationType.Authorize:
      return {
        primaryType: "Authorize",
        message: {
          account: mutation.account,
          expiry: mutation.mutation.expiry,
          keyType: mutation.mutation.keyType,
          permissions: mutation.mutation.permissions,
          publicKey: mutation.mutation.publicKey,
          nonce: mutation.nonce,
          deadline: mutation.deadline,
        },
      };
    case MutationType.Revoke:
      return {
        primaryType: "Revoke",
        message: {
          account: mutation.account,
          keyId: BigInt(mutation.mutation.keyId),
          nonce: mutation.nonce,
          deadline: mutation.deadline,
        },
      };
    case MutationType.CloseOrder:
      return {
        primaryType: "CloseOrder",
        message: {
          orderId: BigInt(mutation.mutation.orderId),
          nonce: mutation.nonce,
          deadline: mutation.deadline,
        },
      };
    case MutationType.LimitOrder:
      return {
        primaryType: "LimitOrder",
        message: {
          quantity: mutation.mutation.quantity,
          instrumentId: BigInt(mutation.mutation.instrumentId),
          price: mutation.mutation.price,
          bidOrAsk: mutation.mutation.bidOrAsk,
          nonce: mutation.nonce,
          deadline: mutation.deadline,
        },
      };
    case MutationType.MarketOrder:
      return {
        primaryType: "MarketOrder",
        message: {
          quantity: mutation.mutation.quantity,
          minReceivedQuantity: mutation.mutation.minReceivedQuantity,
          instrumentId: BigInt(mutation.mutation.instrumentId),
          bidOrAsk: mutation.mutation.bidOrAsk,
          nonce: mutation.nonce,
          deadline: mutation.deadline,
        },
      };
    case MutationType.Deposit:
      return {
        primaryType: "Deposit",
        message: {
          asset: mutation.mutation.asset,
          amount: mutation.mutation.amount,
          nonce: mutation.nonce,
          deadline: mutation.deadline,
        },
      };
    case MutationType.Withdrawal:
      return {
        primaryType: "Withdrawal",
        message: {
          asset: mutation.mutation.asset,
          amount: mutation.mutation.amount,
          nonce: mutation.nonce,
          deadline: mutation.deadline,
        },
      };
  }
}

export async function verifySignature(
  state: State<bigint>,
  eip712Domain: EIP712Domain,
  mutation: TaggedMutation,
): Promise<void> {
  if (mutation.type === MutationType.AddInstrument) return;

  if (mutation.deadline < BigInt(Math.floor(Date.now() / 1000))) {
    throw new Error("SignatureExpired");
  }

  let key: Key;
  if (mutation.type === MutationType.Initialize) {
    key = {
      expiry: 0,
      keyType: mutation.mutation.rootKeyType as KeyType,
      permissions: 0xff,
      publicKey: mutation.mutation.rootPublicKey,
    };
  } else {
    const acc = getAccount(state, mutation.account);
    const k = acc.keys[mutation.keyId];
    if (!k || k.permissions === 0) throw new Error("KeyNotFound");
    if (k.expiry !== 0 && k.expiry < Math.floor(Date.now() / 1000)) {
      throw new Error("KeyExpired");
    }
    const nonceKey = BigInt(mutation.nonce) >> 64n;
    const nonceSeq = BigInt(mutation.nonce) & 0xffffffffffffffffn;
    if (nonceSeq !== getNonceSeq(acc, nonceKey)) {
      throw new Error("InvalidNonce");
    }
    key = k;
  }

  const { primaryType, message } = getTypedDataParams(mutation);
  const typedData = {
    domain: eip712Domain,
    types: EIP712_TYPES,
    primaryType,
    message,
  } as Parameters<typeof hashTypedData>[0];

  if (key.keyType === 2) {
    const recovered = await recoverTypedDataAddress({
      ...typedData,
      signature: mutation.rawSignature,
    });
    const expectedAddress = `0x${key.publicKey.toLowerCase().slice(26)}`;
    if (recovered.toLowerCase() !== expectedAddress) {
      throw new Error("InvalidSignature");
    }
  } else if (key.keyType === 0) {
    const hash = hashTypedData(typedData);
    const [r, s] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      mutation.rawSignature,
    );
    const publicKey = PublicKey.from(key.publicKey as `0x${string}`);
    if (
      P256.verify({
        payload: hash,
        publicKey,
        signature: { r, s },
        hash: true,
      }) === false
    ) {
      throw new Error("InvalidSignature");
    }
  } else if (key.keyType === 1) {
    const hash = hashTypedData(typedData);
    const [authenticatorData, clientDataJSON, r, s] = decodeAbiParameters(
      [
        { type: "bytes" },
        { type: "string" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      mutation.rawSignature,
    );
    const publicKey = PublicKey.from(key.publicKey as `0x${string}`);
    if (
      WebAuthnP256.verify({
        challenge: hash,
        publicKey,
        signature: { r, s },
        metadata: {
          authenticatorData: authenticatorData as Hex,
          clientDataJSON,
        },
        rpId: eip712Domain.rpId,
        origin: eip712Domain.origin,
      }) === false
    ) {
      throw new Error("InvalidSignature");
    }
  } else {
    throw new Error("InvalidSignature");
  }
}

function encodeMutationData(resolved: ResolvedMutation): Hex {
  switch (resolved.type) {
    case MutationType.Initialize:
      return encodeAbiParameters(
        [
          { type: "bytes32", name: "account" },
          { type: "uint40", name: "expiry" },
          { type: "uint8", name: "rootKeyType" },
          { type: "uint8", name: "keyType" },
          { type: "uint8", name: "permissions" },
          { type: "bytes", name: "rootPublicKey" },
          { type: "bytes", name: "publicKey" },
        ],
        [
          resolved.account,
          resolved.mutation.expiry,
          resolved.mutation.rootKeyType,
          resolved.mutation.keyType,
          resolved.mutation.permissions,
          resolved.mutation.rootPublicKey,
          resolved.mutation.publicKey,
        ],
      );

    case MutationType.Authorize:
      return encodeAbiParameters(
        [
          { type: "bytes32", name: "account" },
          { type: "uint40", name: "expiry" },
          { type: "uint8", name: "keyType" },
          { type: "uint8", name: "permissions" },
          { type: "bytes", name: "publicKey" },
          { type: "uint256", name: "nonce" },
          { type: "uint256", name: "deadline" },
        ],
        [
          resolved.account,
          resolved.mutation.expiry,
          resolved.mutation.keyType,
          resolved.mutation.permissions,
          resolved.mutation.publicKey,
          resolved.nonce,
          resolved.deadline,
        ],
      );

    case MutationType.Revoke:
      return encodeAbiParameters(
        [
          { type: "bytes32", name: "account" },
          { type: "uint64", name: "keyId" },
          { type: "uint256", name: "nonce" },
          { type: "uint256", name: "deadline" },
        ],
        [
          resolved.account,
          BigInt(resolved.mutation.keyId),
          resolved.nonce,
          resolved.deadline,
        ],
      );

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

function encodeSignature(resolved: ResolvedMutation): {
  account: Hex;
  keyId: bigint;
  rawSignature: Hex;
} {
  if (resolved.type === MutationType.AddInstrument) {
    return { account: zeroHash, keyId: 0n, rawSignature: "0x" };
  }

  const { v, r, s } = parseSignature(resolved.rawSignature);
  const rawSignature = encodeAbiParameters(
    [{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
    [Number(v), r, s],
  );

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
      await verifySignature(state, eip712Domain, mutation);
      dryRun(state, mutation);
    } catch (err) {
      Effect.runSync(Effect.logError(err));
      throw err;
    }

    if (mutation.type !== MutationType.AddInstrument) {
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
