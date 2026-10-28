import { Effect, Exit, Layer, Scope } from "effect";
import type {
  MutationConfig,
  MutationsConfig,
  SequencingConfig,
  StorageConfig,
  TypewriterConfig,
} from "./config";
import { layerDatabase } from "./db";
import { layerRpc } from "./rpc";
import { makeHttpTransport } from "./rpc-transport";
import {
  loadSolidityTypewriterApp,
  type TypewriterSolidityEntrypoint,
} from "./sol-parse";
import { createTypewriterEffect, type TypewriterEffect } from "./typewriter";
import type {
  BatchListener,
  BlockListener,
  MutationListener,
  On,
  TypewriterMutationInput,
  TypewriterMutationResult,
} from "./typewriter-types";

/** A `TypewriterEffect` with Promise and callback APIs, already running. */
export type Typewriter<
  storageConfig extends StorageConfig = StorageConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = Omit<
  TypewriterEffect<storageConfig, mutationsConfig, sequencingConfig>,
  "execute" | "on" | "program"
> & {
  execute: <const name extends keyof mutationsConfig & string>(
    submitted: TypewriterMutationInput<mutationsConfig, name>,
  ) => Promise<TypewriterMutationResult>;
  on: On<sequencingConfig, mutationsConfig, () => void>;
};

export type { EvmError } from "typewriter-evm";
export type {
  ResolvedTypewriterMutationConfig,
  TypewriterConfig,
  TypewriterManifest,
} from "./config";
export { DbError } from "./db";
export { MigrationError } from "./db-migrate";
export type { TypewriterMutationSchema } from "./db-schema";
export { type RpcError, RpcTimeoutError } from "./rpc";
export { BlockNotFoundError, NoDataReturnedError } from "./rpc-request";
export {
  RpcHttpError,
  RpcNetworkError,
  RpcResponseError,
  type RpcTransportError,
} from "./rpc-transport";
export type { TypewriterSolidityEntrypoint } from "./sol-parse";
export {
  type CreateTypewriterError,
  EncodeMutationError,
  type ExecuteError,
  type ExecuteMutationError,
  MutationHaltedError,
  MutationRevertedError,
  type ProgramError,
  ProgramStoppedError,
  SettlementReorgedError,
  SettlementRevertedError,
  SettlementSimulationHaltedError,
  SettlementSimulationRevertedError,
  SignTransactionError,
  TypewriterStoppedError,
  UnknownMutationError,
} from "./typewriter";
export type {
  Account,
  AddCredentialParams,
  Authorization,
  BatchEvent,
  BatchStatus,
  BlockEvent,
  BlockStatus,
  CreateAccountParams,
  Credential,
  KeyType,
  MutationEvent,
  MutationStatus,
  RemoveCredentialParams,
  TypewriterMutation,
  TypewriterMutationInput,
  TypewriterMutationResult,
} from "./typewriter-types";
export {
  IncompleteBlockError,
  UnrecoverableReorgError,
  type WatchError,
} from "./watch";

type EntrypointMetadata<entrypoint> =
  entrypoint extends TypewriterSolidityEntrypoint<infer metadata>
    ? metadata
    : unknown;

type EntrypointStorageConfig<entrypoint> =
  EntrypointMetadata<entrypoint> extends {
    readonly storageLayout: infer storage extends StorageConfig;
  }
    ? storage
    : StorageConfig;

type EntrypointMutationsConfig<entrypoint> =
  EntrypointMetadata<entrypoint> extends {
    readonly mutations: infer mutations extends Record<string, MutationConfig>;
  }
    ? mutations
    : MutationsConfig;

export async function createTypewriter<
  const entrypoint extends TypewriterSolidityEntrypoint,
  const sequencingConfig extends SequencingConfig = SequencingConfig,
>(
  entrypoint: entrypoint,
  config: TypewriterConfig<sequencingConfig>,
): Promise<
  Typewriter<
    EntrypointStorageConfig<entrypoint>,
    EntrypointMutationsConfig<entrypoint>,
    sequencingConfig
  >
> {
  type Result = Typewriter<
    EntrypointStorageConfig<entrypoint>,
    EntrypointMutationsConfig<entrypoint>,
    sequencingConfig
  >;

  const app = await loadSolidityTypewriterApp(entrypoint, config);
  // TODO(kyle) expose a way to close the scope. Until then the typewriter
  // runs until the process exits.
  const scope = Effect.runSync(Scope.make());

  try {
    const typewriter = await Effect.runPromise(
      Effect.gen(function* () {
        const [rpcUrl, ...rpcUrls] = app.rpcUrls;
        const services = yield* Layer.buildWithScope(
          Layer.merge(
            layerRpc([
              makeHttpTransport(rpcUrl),
              ...rpcUrls.map(makeHttpTransport),
            ]),
            layerDatabase(app.database),
          ),
          scope,
        );
        const typewriter = yield* createTypewriterEffect<
          EntrypointStorageConfig<entrypoint>,
          EntrypointMutationsConfig<entrypoint>,
          sequencingConfig
        >(app).pipe(
          Effect.provide(services),
          Effect.provideService(Scope.Scope, scope),
        );
        yield* typewriter.program.pipe(
          // A failed program can't accept mutations. Crash the process rather
          // than serve stale state.
          Effect.tapError((error) =>
            Effect.sync(() =>
              queueMicrotask(() => {
                throw error;
              }),
            ),
          ),
          Effect.forkIn(scope),
        );
        return typewriter;
      }),
    );

    const execute = ((
      submitted: TypewriterMutationInput<EntrypointMutationsConfig<entrypoint>>,
    ) => Effect.runPromise(typewriter.execute(submitted))) as Result["execute"];

    const on = ((
      event: "mutation" | "batch" | "block",
      cb:
        | MutationListener<EntrypointMutationsConfig<entrypoint>>
        | BatchListener<EntrypointMutationsConfig<entrypoint>>
        | BlockListener<
            sequencingConfig,
            EntrypointMutationsConfig<entrypoint>
          >,
    ) =>
      Effect.runSync(
        // @ts-expect-error `on` is overloaded per event, and this forwards whichever event and listener the caller passed.
        typewriter.on(event, cb),
      )) as Result["on"];

    return {
      state: typewriter.state,
      accounts: typewriter.accounts,
      schema: typewriter.schema,
      manifest: typewriter.manifest,
      execute,
      on,
    } as Result;
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}
