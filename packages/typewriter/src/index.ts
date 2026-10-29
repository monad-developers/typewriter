import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer, Scope } from "effect";
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
  type ExecuteError,
  type ExecuteMutationError,
  MutationHaltedError,
  MutationRevertedError,
  type ProgramError,
  ProgramStoppedError,
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

/** How long a signal waits for the scope to close before ending the process. */
const SIGNAL_CLOSE_TIMEOUT_MS = 10_000;

/**
 * Returns a function that closes `scope` once. SIGINT and SIGTERM close it
 * too, so its finalizers stop the program, release the database, and in `dev`
 * mode stop Anvil and drop the schema. Without other listeners, the signal
 * then ends the process as it would have.
 */
function closeOnSignals(scope: Scope.Closeable): () => Promise<void> {
  let closing: Promise<void> | undefined;
  const close = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    closing ??= Effect.runPromise(Scope.close(scope, Exit.void));
    return closing;
  };
  const onSignal = (signal: NodeJS.Signals) => {
    void Promise.race([close(), Bun.sleep(SIGNAL_CLOSE_TIMEOUT_MS)]).finally(
      () => {
        if (process.listenerCount(signal) === 0) {
          process.kill(process.pid, signal);
        }
      },
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return close;
}

/**
 * Logs `cause` and exits the process. A typewriter that failed to start or
 * stopped can't accept mutations, so it crashes rather than serve stale state.
 */
function exit(msg: string, cause: Cause.Cause<unknown>): never {
  logError(msg, cause);
  process.exit(1);
}

function logError(msg: string, cause: Cause.Cause<unknown>): void {
  Effect.runSync(Effect.logError(msg, cause).pipe(Effect.provide(loggerLayer)));
}

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

  const metadata = await Promise.resolve()
    .then(() => {
      // Check the config before `dev` mode starts Anvil for it.
      validateConfig(config);
      return loadSolidityMetadata(entrypoint);
    })
    .catch((error: unknown) =>
      exit("Failed to start typewriter", Cause.fail(error)),
    );
  const scope = Effect.runSync(Scope.make());
  const close = closeOnSignals(scope);

  try {
    const { typewriter, services } = await Effect.runPromise(
      Effect.gen(function* () {
        const devChain =
          config.dev === true
            ? yield* startDevChain(metadata.bytecode).pipe(
                Effect.provide([loggerLayer, BunServices.layer]),
                Effect.provideService(Scope.Scope, scope),
              )
            : undefined;
        const app = yield* Effect.try({
          try: () => createSolidityTypewriterApp(config, metadata, devChain),
          catch: (error) => error,
        });
        const [rpcUrl, ...rpcUrls] = app.rpcUrls;
        const services = yield* Layer.buildWithScope(
          Layer.mergeAll(
            loggerLayer,
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
          Effect.provide(services),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.sync(() => {
                  // Close before exiting, so the finalizers run.
                  logError("Stopped typewriter", cause);
                  void close().finally(() => process.exit(1));
                }),
          ),
          Effect.forkIn(scope),
        );
        return { typewriter, services };
      }),
    );

    const execute = ((
      submitted: TypewriterMutationInput<EntrypointMutationsConfig<entrypoint>>,
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

    return {
      state: typewriter.state,
      accounts: typewriter.accounts,
      schema: typewriter.schema,
      manifest: typewriter.manifest,
      execute,
      on,
    } as Result;
  } catch (error) {
    await close();
    exit("Failed to start typewriter", Cause.fail(error));
  }
}
