import { Data, Effect, type Scope } from "effect";
import {
  createEVM,
  type EVM,
  type EvmError,
  type ExecuteResult,
} from "ffca-evm";
import type { Hex } from "ox";
import { createStorageProxy, type StorageProxy } from "storage-layout";
import {
  ContractFunctionRevertedError,
  decodeEventLog,
  RawContractError,
} from "viem";
import { Database } from "./db";
import { selectAccountStorage, selectKnownPaths } from "./db-query";
import {
  decodeMutationCalldata,
  encodeBatchArg,
  encodeEnqueueCalldata,
  encodeExecuteCalldata,
  type FFCAAbi,
} from "./encoding";
import type { InternalApp } from "./internal";
import { durationMs, startTimer } from "./logger";
import { Rpc } from "./rpc";
import type {
  AcceptedMutation,
  BatchEvent,
  BlockEvent,
  EnqueuedMutation,
  MutationEvent,
  ReceivedMutation,
  RejectedMutation,
  RuntimeBatch,
  RuntimeBlock,
  RuntimeMutation,
  SubmittedMutation,
} from "./types";
import type { LocalLog } from "./watch";

export function updateMutationToAccepted(
  mutation: ReceivedMutation | EnqueuedMutation,
  params: {
    journalId: number;
    isForceInclusion: boolean;
    resolution?: unknown;
  },
): AcceptedMutation {
  const acceptedMutation = mutation as unknown as AcceptedMutation;
  acceptedMutation.status = "accepted";
  acceptedMutation.journalId = params.journalId;
  acceptedMutation.isForceInclusion = params.isForceInclusion;
  acceptedMutation.resolution = params.resolution;
  return acceptedMutation;
}

export function updateMutationToRejected(
  mutation: ReceivedMutation | EnqueuedMutation,
  params: { error: unknown },
): RejectedMutation {
  const rejectedMutation = mutation as unknown as RejectedMutation;
  rejectedMutation.status = "rejected";
  rejectedMutation.isForceInclusion = false;
  rejectedMutation.error = params.error;
  return rejectedMutation;
}

export function updateMutationToIncluded(
  mutation: AcceptedMutation,
): SubmittedMutation {
  const includedMutation = mutation as unknown as SubmittedMutation;
  includedMutation.status = "included";
  return includedMutation;
}

export function updateMutationToSafe(
  mutation: SubmittedMutation,
): SubmittedMutation {
  const safeMutation = mutation as SubmittedMutation;
  safeMutation.status = "safe";
  return safeMutation;
}

export function updateMutationToFinalized(
  mutation: SubmittedMutation,
): SubmittedMutation {
  const finalizedMutation = mutation as SubmittedMutation;
  finalizedMutation.status = "finalized";
  return finalizedMutation;
}

export function mutationToEvent(mutation: RuntimeMutation): MutationEvent {
  const { config: _config, ...event } = mutation;
  return { ...event };
}

export function batchToEvent(batch: RuntimeBatch): BatchEvent {
  return {
    ...batch,
    mutations: batch.mutations.map(mutationToEvent),
  } as BatchEvent;
}

export function fifoBlockToEvent(
  block: RuntimeBlock<"fifo">,
): BlockEvent<"fifo"> {
  const { mutations, ...rest } = block;
  return {
    ...rest,
    mutations: mutations.map(mutationToEvent),
  } as BlockEvent<"fifo">;
}

export function batchBlockToEvent(
  block: RuntimeBlock<"batch">,
): BlockEvent<"batch"> {
  return {
    status: block.status,
    number: block.number,
    hash: block.hash,
    timestamp: block.timestamp,
    transactionHash: block.transactionHash,
    batches: block.batches.map(batchToEvent) as Exclude<
      BatchEvent,
      { status: "accepted" }
    >[],
    forceIncludedMutations: block.forceIncludedMutations.map(
      mutationToEvent,
    ) as BlockEvent<"batch">["forceIncludedMutations"],
  };
}

async function resolveMutation(
  mutation: ReceivedMutation,
  state: unknown,
): Promise<unknown> {
  if ("resolve" in mutation.config) {
    return mutation.config.resolve({
      state,
      args: mutation.args,
      signature: mutation.signature,
    });
  }
  return undefined;
}

async function registerKnownPaths(
  mutation: AcceptedMutation,
): Promise<readonly string[]> {
  if (mutation.config.registerMappingKeys === undefined) return [];
  return mutation.config.registerMappingKeys({
    args: mutation.args,
    signature: mutation.signature,
    resolution: mutation.resolution,
  });
}

export class ResolveMutationError extends Data.TaggedError(
  "ResolveMutationError",
)<{
  readonly mutation: ReceivedMutation | EnqueuedMutation;
  readonly cause: unknown;
}> {}

export class RegisterKnownPathsError extends Data.TaggedError(
  "RegisterKnownPathsError",
)<{
  readonly mutation: ReceivedMutation | EnqueuedMutation;
  readonly cause: unknown;
}> {}

export class EncodeMutationError extends Data.TaggedError(
  "EncodeMutationError",
)<{
  readonly mutation: ReceivedMutation | EnqueuedMutation;
  readonly cause: unknown;
}> {}

export function executeMutation(params: {
  app: InternalApp;
  state: unknown;
  evm: EVM;
  mutation: ReceivedMutation | EnqueuedMutation;
}): Effect.Effect<
  {
    mutation: AcceptedMutation;
    executeResult: ExecuteResult;
    knownPaths: readonly string[];
  },
  | ResolveMutationError
  | RegisterKnownPathsError
  | EncodeMutationError
  | EvmError
  | ContractFunctionRevertedError
> {
  return Effect.gen(function* () {
    let resolution: unknown;
    if (params.mutation.status === "enqueued") {
      resolution = params.mutation.resolution;
    } else {
      const mutation = params.mutation;
      resolution = yield* Effect.tryPromise({
        try: () => resolveMutation(mutation, params.state),
        catch: (cause) =>
          new ResolveMutationError({
            mutation,
            cause,
          }),
      });
    }

    const acceptedMutation = updateMutationToAccepted(params.mutation, {
      journalId: -1,
      isForceInclusion: params.mutation.status === "enqueued",
      resolution,
    });

    const knownPaths = yield* Effect.tryPromise({
      try: () => registerKnownPaths(acceptedMutation),
      catch: (cause) =>
        new RegisterKnownPathsError({
          mutation: params.mutation,
          cause,
        }),
    });

    const mutationCalldata = yield* Effect.try({
      try: () =>
        params.mutation.status === "enqueued"
          ? encodeExecuteCalldata(
              params.app.abi,
              [],
              [params.mutation.queueIndex],
            )
          : encodeExecuteCalldata(
              params.app.abi,
              [encodeBatchArg(params.app.abi, [acceptedMutation])],
              [],
            ),
      catch: (cause) =>
        new EncodeMutationError({ mutation: params.mutation, cause }),
    });

    const executeStartedAtMs = startTimer();
    const executeResult = yield* params.evm.execute({
      from: params.app.account.address,
      to: params.app.address,
      data: mutationCalldata,
    });

    yield* Effect.logDebug("executed mutation").pipe(
      Effect.annotateLogs({
        id: acceptedMutation.id,
        name: acceptedMutation.name,
        success: executeResult.success,
        slotWriteCount: executeResult.slot_writes.length,
        knownPathCount: knownPaths.length,
        duration: durationMs(executeStartedAtMs),
      }),
    );

    if (executeResult.success === false) {
      return yield* Effect.fail(
        createRevmRevertError(params.app, executeResult.revert_data),
      );
    }

    acceptedMutation.journalId = executeResult.journal_id!;

    return {
      mutation: acceptedMutation,
      executeResult,
      knownPaths,
    };
  });
}

export function enqueueMutation(params: {
  app: InternalApp;
  evm: EVM;
  mutation: EnqueuedMutation;
}): Effect.Effect<ExecuteResult, EvmError> {
  return Effect.gen(function* () {
    const enqueueCalldata = encodeEnqueueCalldata(
      params.app.abi,
      params.mutation,
    );

    return yield* params.evm.execute({
      from: "0x0000000000000000000000000000000000000000",
      to: params.app.address,
      data: enqueueCalldata,
    });
  });
}

type RawSlotMap = { [slot: Hex.Hex]: Hex.Hex };
const SLOT_CACHE_MAX_ENTRIES = 200_000;

export function decodeEnqueuedMutation(params: {
  app: InternalApp;
  log: LocalLog;
  id: number;
}): EnqueuedMutation {
  const forceInclusionLog = decodeEventLog({
    abi: params.app.abi as FFCAAbi,
    eventName: "ForceInclusionQueued",
    // @ts-expect-error viem's decoded log topic tuple type is narrower than LocalLog's runtime topics.
    topics: params.log.topics,
    data: params.log.data,
    strict: true,
  }).args;

  const decodedSignature = forceInclusionLog as typeof forceInclusionLog & {
    signature?: unknown;
  };

  const [mutationName, mutationConfig] = Object.entries(
    params.app.mutations,
  ).find(
    ([_, mutationConfig]) => mutationConfig.tag === forceInclusionLog.mutation,
  )!;

  return {
    status: "enqueued",
    id: params.id,
    name: mutationName,
    config: mutationConfig,
    signature:
      "sig" in forceInclusionLog
        ? forceInclusionLog.sig
        : decodedSignature.signature,
    isForceInclusion: true,
    queueIndex: forceInclusionLog.index,
    ...decodeMutationCalldata(mutationConfig, forceInclusionLog.mutationData),
  };
}

export function createRevmRevertError(
  app: InternalApp,
  data: Hex.Hex | undefined,
  message = "revm execute reverted",
): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({
    abi: app.abi,
    data,
    functionName: "execute",
    message,
    cause: new RawContractError({ data, message }),
  });
}

export function createRuntimeState(app: InternalApp): Effect.Effect<
  {
    evm: EVM;
    state: StorageProxy<InternalApp["storageLayout"], true>;
    knownPaths: string[];
    invalidateStorageCache: (slots?: readonly Hex.Hex[]) => void;
  },
  unknown,
  Database | Rpc | Scope.Scope
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const rpc = yield* Rpc;

    const { initialAccountStorage, knownPaths } = yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const knownPaths = yield* selectKnownPaths(tx, app.schema);
        const initialAccountStorage = yield* selectAccountStorage(
          tx,
          app.schema,
        );

        return {
          knownPaths,
          initialAccountStorage,
        };
      }),
    );

    const evm = yield* createEVM();
    const code = yield* rpc.request({
      method: "eth_getCode",
      params: [app.address, "latest"],
    });

    if (code === undefined || code === "0x") {
      yield* Effect.logWarning(
        `no contract code at app.address=${app.address}; ` +
          "revm code load skipped - runtime will continue but revm has no contract bytecode",
      );
      yield* evm.init({
        chain_id: app.chainId,
        accounts: {
          [app.address]: {
            storage: initialAccountStorage,
          },
        },
      });
    } else {
      yield* evm.init({
        chain_id: app.chainId,
        accounts: {
          [app.address]: {
            code,
            storage: initialAccountStorage,
          },
        },
      });
    }

    let slotCache: RawSlotMap = {};
    const invalidateStorageCache = (slots?: readonly Hex.Hex[]) => {
      if (slots === undefined) {
        slotCache = {};
        return;
      }

      for (const slot of slots) {
        delete slotCache[slot];
      }
    };

    const state = createStorageProxy(
      app.storageLayout,
      async (slots) => {
        const missingSlots = slots.filter(
          (slot) => slotCache[slot] === undefined,
        );
        if (missingSlots.length > 0) {
          const fetched = await Effect.runPromise(
            evm.readStorage({ address: app.address, slots: missingSlots }),
          );
          for (const [slot, value] of Object.entries(fetched) as [
            Hex.Hex,
            Hex.Hex,
          ][]) {
            slotCache[slot] = value;
          }

          while (Object.keys(slotCache).length > SLOT_CACHE_MAX_ENTRIES) {
            const oldestSlot = Object.keys(slotCache).values().next().value;
            delete slotCache[oldestSlot as Hex.Hex];
          }
        }

        return Object.fromEntries(
          slots.map((slot) => [slot, slotCache[slot]!]),
        ) as RawSlotMap;
      },
      knownPaths,
    );

    return { evm, state, knownPaths, invalidateStorageCache };
  });
}

export function nextBlockStatus(
  block: Pick<RuntimeBlock<"fifo" | "batch">, "number" | "status">,
  currentBlockNumber: bigint,
  confirmations: InternalApp["confirmations"],
): "safe" | "finalized" | undefined {
  const blockDepth = currentBlockNumber - block.number;
  if (
    blockDepth >= BigInt(confirmations.finalizedBlockDepth) &&
    block.status !== "finalized"
  ) {
    return "finalized";
  }

  if (
    blockDepth >= BigInt(confirmations.safeBlockDepth) &&
    block.status !== "safe" &&
    block.status !== "finalized"
  ) {
    return "safe";
  }

  return undefined;
}
