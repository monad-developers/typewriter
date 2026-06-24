import { Effect, Exit, Scope } from "effect";
import type { TypedData } from "ox";
import type { StorageProxy } from "storage-layout";
import type {
  MutationConfig,
  MutationsConfig,
  SequencingConfig,
  SignatureConfig,
  StorageConfig,
  TypewriterConfig,
} from "./config";
import { createTypewriterEffect } from "./typewriter";

export { TYPEWRITER_DOMAIN } from "./eip712";

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

export type Typewriter<
  storageConfig extends StorageConfig = StorageConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = {
  readonly state: StorageProxy<storageConfig, true>;
  readonly schema: TypewriterSchema<mutationsConfig, signatureConfig>;
  readonly domain: TypedData.Domain;
  execute: <const name extends keyof mutationsConfig & string>(
    submitted: TypewriterMutationInput<mutationsConfig, signatureConfig, name>,
  ) => Promise<TypewriterMutationResult>;
  close: () => Promise<void>;
  on(
    event: "mutation",
    cb: MutationListener<mutationsConfig, signatureConfig>,
  ): () => void;
  on(
    event: "batch",
    cb: BatchListener<mutationsConfig, signatureConfig>,
  ): () => void;
  on(
    event: "block",
    cb: BlockListener<sequencingConfig, mutationsConfig, signatureConfig>,
  ): () => void;
};

export type {
  ResolvedTypewriterMutationConfig,
  TypewriterConfig,
} from "./config";
export type {
  TypewriterMutationSchema,
  TypewriterSchema,
  TypewriterStateSchema,
} from "./schema";
export type { KeyType } from "./signature";
export type { TypewriterSolidityEntrypoint } from "./sol-parse";
export type {
  BatchEvent,
  BatchStatus,
  BlockEvent,
  BlockStatus,
  MutationEvent,
  MutationStatus,
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

type EntrypointSignatureConfig<entrypoint> =
  EntrypointMetadata<entrypoint> extends {
    readonly signature: infer signature extends SignatureConfig;
  }
    ? signature
    : SignatureConfig;

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
    EntrypointSignatureConfig<entrypoint>,
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
    EntrypointSignatureConfig<entrypoint>,
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
        EntrypointSignatureConfig<entrypoint>,
        sequencingConfig
      >(app).pipe(Effect.provideService(Scope.Scope, scope)),
    );

    const runtimeOn = typewriter.on as unknown as (
      event: "mutation" | "batch" | "block",
      cb: unknown,
    ) => Effect.Effect<() => void>;
    const on = ((event, cb) =>
      Effect.runSync(runtimeOn(event, cb))) as Typewriter<
      EntrypointStorageConfig<entrypoint>,
      EntrypointMutationsConfig<entrypoint>,
      EntrypointSignatureConfig<entrypoint>,
      sequencingConfig
    >["on"];

    const execute = ((
      submitted: TypewriterMutationInput<
        EntrypointMutationsConfig<entrypoint>,
        EntrypointSignatureConfig<entrypoint>
      >,
    ) => Effect.runPromise(typewriter.execute(submitted))) as Typewriter<
      EntrypointStorageConfig<entrypoint>,
      EntrypointMutationsConfig<entrypoint>,
      EntrypointSignatureConfig<entrypoint>,
      sequencingConfig
    >["execute"];

    return {
      state: typewriter.state as StorageProxy<
        EntrypointStorageConfig<entrypoint>,
        true
      >,
      schema: typewriter.schema as unknown as TypewriterSchema<
        EntrypointMutationsConfig<entrypoint>,
        EntrypointSignatureConfig<entrypoint>
      >,
      domain: typewriter.domain,
      execute,
      close: closeScope,
      on,
    };
  } catch (error) {
    await closeScope();
    throw error;
  }
}
