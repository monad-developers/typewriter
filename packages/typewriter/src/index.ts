import { Effect, Exit, Scope } from "effect";
import type { StorageView } from "storage-layout";
import type {
  MutationConfig,
  MutationsConfig,
  SequencingConfig,
  StorageConfig,
  TypewriterConfig,
  TypewriterManifest,
} from "./config";
import type { TypewriterSchema } from "./schema";
import {
  loadSolidityTypewriterApp,
  type TypewriterSolidityEntrypoint,
} from "./sol-parse";
import type {
  BatchListener,
  BlockListener,
  MutationListener,
  TypewriterMutationInput,
  TypewriterMutationResult,
} from "./types";
import { createTypewriterEffect } from "./typewriter";

type StorageRootProperty<
  storageConfig extends StorageConfig,
  name extends "accounts" | "state",
> =
  StorageView<storageConfig, false> extends infer root
    ? name extends keyof root
      ? root[name]
      : never
    : never;

export type Typewriter<
  storageConfig extends StorageConfig = StorageConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = {
  readonly state: StorageRootProperty<storageConfig, "state">;
  readonly accounts: StorageRootProperty<storageConfig, "accounts">;
  readonly schema: TypewriterSchema<mutationsConfig>;
  readonly manifest: TypewriterManifest<mutationsConfig>;
  execute: <const name extends keyof mutationsConfig & string>(
    submitted: TypewriterMutationInput<mutationsConfig, name>,
  ) => Promise<TypewriterMutationResult>;
  close: () => Promise<void>;
  on(event: "mutation", cb: MutationListener<mutationsConfig>): () => void;
  on(event: "batch", cb: BatchListener<mutationsConfig>): () => void;
  on(
    event: "block",
    cb: BlockListener<sequencingConfig, mutationsConfig>,
  ): () => void;
};

export type {
  ResolvedTypewriterMutationConfig,
  TypewriterConfig,
  TypewriterManifest,
} from "./config";
export type {
  TypewriterMutationSchema,
  TypewriterSchema,
  TypewriterStateSchema,
} from "./schema";
export type { TypewriterSolidityEntrypoint } from "./sol-parse";
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
} from "./types";

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
>;
export async function createTypewriter<
  const entrypoint extends TypewriterSolidityEntrypoint,
  const sequencingConfig extends SequencingConfig = SequencingConfig,
>(
  entrypoint: entrypoint,
  publicConfig: TypewriterConfig<sequencingConfig>,
): Promise<
  Typewriter<
    EntrypointStorageConfig<entrypoint>,
    EntrypointMutationsConfig<entrypoint>,
    sequencingConfig
  >
> {
  const app = await loadSolidityTypewriterApp(entrypoint, publicConfig);
  const scope = Effect.runSync(Scope.make());
  let closed = false;

  async function closeScope() {
    if (closed) return;
    closed = true;
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }

  try {
    const typewriter = await Effect.runPromise(
      createTypewriterEffect<
        EntrypointStorageConfig<entrypoint>,
        EntrypointMutationsConfig<entrypoint>,
        sequencingConfig
      >(app).pipe(Effect.provideService(Scope.Scope, scope)),
    );

    type PublicTypewriter = Typewriter<
      EntrypointStorageConfig<entrypoint>,
      EntrypointMutationsConfig<entrypoint>,
      sequencingConfig
    >;
    type Mutations = EntrypointMutationsConfig<entrypoint>;

    const on: PublicTypewriter["on"] = (
      event: "mutation" | "batch" | "block",
      cb:
        | MutationListener<Mutations>
        | BatchListener<Mutations>
        | BlockListener<sequencingConfig, Mutations>,
    ) =>
      Effect.runSync(
        // @ts-expect-error each event is forwarded with its own listener type, but the runtime's overloads can't be called with the union.
        typewriter.on(event, cb),
      );

    const execute: PublicTypewriter["execute"] = (submitted) =>
      Effect.runPromise(
        // @ts-expect-error `TypewriterMutationInput<M, name>` narrows `TypewriterMutationInput<M>`, but TS can't relate them for a generic `name`.
        typewriter.execute(submitted),
      );

    return {
      state: typewriter.state,
      accounts: typewriter.accounts,
      schema: typewriter.schema,
      manifest: typewriter.manifest,
      execute,
      close: closeScope,
      on,
    };
  } catch (error) {
    await closeScope();
    throw error;
  }
}
