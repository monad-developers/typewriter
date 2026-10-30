import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cause, Deferred, Effect, Layer } from "effect";
import { startDevChain } from "./anvil";
import {
  type MutationConfig,
  type MutationsConfig,
  type SequencingConfig,
  type StorageConfig,
  type TypewriterConfig,
  validateConfig,
} from "./config";
import { layerDatabase } from "./db";
import { loggerLayer } from "./logger";
import { layerRpc } from "./rpc";
import { makeHttpTransport } from "./rpc-transport";
import {
  createSolidityTypewriterApp,
  loadSolidityMetadata,
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

export type { EvmError, Spec } from "typewriter-evm";
export { AnvilError } from "./anvil";
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
  ChainIdMismatchError,
  type CreateTypewriterError,
  EncodeMutationError,
  EnqueueReorgedError,
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

export function createTypewriter<
  const entrypoint extends TypewriterSolidityEntrypoint,
  const sequencingConfig extends SequencingConfig = SequencingConfig,
  const dev extends boolean = false,
>(
  entrypoint: entrypoint,
  config: TypewriterConfig<sequencingConfig, dev>,
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

  const started = Deferred.makeUnsafe<Result>();

  // The typewriter runs as the process's main fiber. SIGINT and SIGTERM
  // interrupt it, so its scope's finalizers stop the program, release the
  // deployment lock and the database, and in `dev` mode drop the schema and
  // stop Anvil, before the process exits. A typewriter that fails to start or
  // stops can't accept mutations, so the process exits rather than serve
  // stale state.
  BunRuntime.runMain(
    Effect.gen(function* () {
      // Check the config before `dev` mode starts Anvil for it.
      yield* Effect.try({
        try: () => validateConfig(config),
        catch: (error) => error,
      });
      const metadata = yield* Effect.tryPromise({
        try: () => loadSolidityMetadata(entrypoint),
        catch: (error) => error,
      });
      const devChain =
        config.dev === true
          ? yield* startDevChain(metadata.bytecode)
          : undefined;
      const app = yield* Effect.try({
        try: () => createSolidityTypewriterApp(config, metadata, devChain),
        catch: (error) => error,
      });
      const [rpcUrl, ...rpcUrls] = app.rpcUrls;
      const services = yield* Layer.build(
        Layer.mergeAll(
          loggerLayer,
          layerRpc([
            makeHttpTransport(rpcUrl),
            ...rpcUrls.map(makeHttpTransport),
          ]),
          layerDatabase(app.database),
        ),
      );
      const typewriter = yield* createTypewriterEffect<
        EntrypointStorageConfig<entrypoint>,
        EntrypointMutationsConfig<entrypoint>,
        sequencingConfig
      >(app).pipe(Effect.provide(services));

      const execute = ((
        submitted: TypewriterMutationInput<
          EntrypointMutationsConfig<entrypoint>
        >,
      ) =>
        Effect.runPromise(
          typewriter.execute(submitted).pipe(Effect.provide(services)),
        )) as Result["execute"];

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

      yield* Deferred.succeed(started, {
        state: typewriter.state,
        accounts: typewriter.accounts,
        schema: typewriter.schema,
        manifest: typewriter.manifest,
        execute,
        on,
      } as Result);

      return yield* typewriter.program.pipe(Effect.provide(services));
    }).pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.flatMap(Deferred.isDone(started), (isStarted) =>
              Effect.logError(
                isStarted ? "Stopped typewriter" : "Failed to start typewriter",
                cause,
              ),
            ),
      ),
      Effect.scoped,
      Effect.provide([loggerLayer, BunServices.layer]),
    ),
    // The log above reports the failure with typewriter's logger.
    { disableErrorReporting: true },
  );

  return Effect.runPromise(Deferred.await(started));
}
