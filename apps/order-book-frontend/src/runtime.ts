import { Duration, Effect, Fiber, Schedule } from "effect";
import type { Address, Chain, Hex } from "viem";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  recoverTypedDataAddress,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
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
  | "accepted"
  | "proposed"
  | "voted"
  | "finalized"
  | "verified";

export type MutationTicket = { id: number };

export type RuntimeConfig = {
  state: State<bigint>;
  flushIntervalMs: number;
  chain: Chain;
  rpcUrl: string;
  account: PrivateKeyAccount;
  exchangeAddress: Address;
};

type QueueEntry = {
  id: number;
  tagged: TaggedMutation;
  resolve: ((resolved: { id: number } & ResolvedMutation) => void) | null;
};

export type RuntimeHandle = {
  execute<T extends TaggedMutation>(
    mutation: T,
  ): Promise<{ id: number } & Extract<ResolvedMutation, { type: T["type"] }>>;
  getStatus(id: number): MutationStatus | undefined;
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
  const zeroBytes32 =
    "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: "execute",
    args: [
      {
        mutations: resolved.map((r) => r.type),
        mutationData: resolved.map(encodeMutationData),
        v: resolved.map(() => 0),
        r: resolved.map(() => zeroBytes32),
        s: resolved.map(() => zeroBytes32),
      },
    ],
  });
}

function dryRun(
  state: State<bigint>,
  mutation: TaggedMutation,
): void {
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
  const state = config.state;
  const queue: QueueEntry[] = [];
  const statuses = new Map<number, MutationStatus>();
  let nextId = 0;

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
    verifyingContract: config.exchangeAddress,
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

    const opts = { domain: eip712Domain, types: EIP712_TYPES, signature: mutation.signature } as const;
    let recovered: Address;

    switch (mutation.type) {
      case MutationType.CloseOrder:
        recovered = await recoverTypedDataAddress({
          ...opts, primaryType: "CloseOrder",
          message: { orderId: BigInt(mutation.mutation.orderId), nonce: mutation.nonce, deadline: mutation.deadline },
        });
        break;
      case MutationType.LimitOrder:
        recovered = await recoverTypedDataAddress({
          ...opts, primaryType: "LimitOrder",
          message: { quantity: mutation.mutation.quantity, instrumentId: BigInt(mutation.mutation.instrumentId), price: mutation.mutation.price, bidOrAsk: mutation.mutation.bidOrAsk, nonce: mutation.nonce, deadline: mutation.deadline },
        });
        break;
      case MutationType.MarketOrder:
        recovered = await recoverTypedDataAddress({
          ...opts, primaryType: "MarketOrder",
          message: { quantity: mutation.mutation.quantity, minReceivedQuantity: mutation.mutation.minReceivedQuantity, instrumentId: BigInt(mutation.mutation.instrumentId), bidOrAsk: mutation.mutation.bidOrAsk, nonce: mutation.nonce, deadline: mutation.deadline },
        });
        break;
      case MutationType.Deposit:
        recovered = await recoverTypedDataAddress({
          ...opts, primaryType: "Deposit",
          message: { asset: mutation.mutation.asset, amount: mutation.mutation.amount, nonce: mutation.nonce, deadline: mutation.deadline },
        });
        break;
      case MutationType.Withdrawal:
        recovered = await recoverTypedDataAddress({
          ...opts, primaryType: "Withdrawal",
          message: { asset: mutation.mutation.asset, amount: mutation.mutation.amount, nonce: mutation.nonce, deadline: mutation.deadline },
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
        statuses.set(entry.id, "accepted");
        entry.resolve?.({ id: entry.id, ...r });
      }
    }

    const _calldata = encodeBundle(resolved);

    // TODO: submit _calldata on-chain (createAccessList → prepareTransactionRequest → signTransaction → sendRawTransactionSync)

    const ids = batch.map((e) => e.id);
    yield* Effect.forkDaemon(
      Effect.gen(function* () {
        for (const id of ids) statuses.set(id, "proposed");
        yield* Effect.sleep(Duration.millis(400));
        for (const id of ids) statuses.set(id, "voted");
        yield* Effect.sleep(Duration.millis(400));
        for (const id of ids) statuses.set(id, "finalized");
        yield* Effect.sleep(Duration.millis(1200));
        for (const id of ids) statuses.set(id, "verified");
      }),
    );
  });

  const program = Effect.repeat(
    flushOnce,
    Schedule.spaced(Duration.millis(config.flushIntervalMs)),
  );

  const fiber = Effect.runFork(program);

  async function execute<T extends TaggedMutation>(
    mutation: T,
  ): Promise<{ id: number } & Extract<ResolvedMutation, { type: T["type"] }>> {
    await verifySignature(mutation);
    dryRun(state, mutation);

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
    return promise;
  }

  function getStatus(id: number): MutationStatus | undefined {
    return statuses.get(id);
  }

  async function stop(): Promise<void> {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }

  return { execute, getStatus, stop } as RuntimeHandle;
}
