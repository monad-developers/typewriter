import { Effect, Exit, Scope } from "effect";
import type { TypedData } from "ox";
import type { StorageProxy } from "storage-layout";
import type {
  FFCAConfig,
  MutationConfig,
  MutationsConfig,
  SequencingConfig,
  SignatureConfig,
  StorageConfig,
} from "./config";
import { createFFCAEffect } from "./typewriter";

export { FFCA_DOMAIN } from "./eip712";

import type { FFCASchema } from "./schema";
import { type FFCASolidityEntrypoint, loadSolidityFFCAApp } from "./sol-parse";
import type {
  BatchListener,
  BlockListener,
  FFCAMutationInput,
  FFCAMutationResult,
  MutationListener,
} from "./types";

export type FFCA<
  storageConfig extends StorageConfig = StorageConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = {
  readonly state: StorageProxy<storageConfig, true>;
  readonly schema: FFCASchema<mutationsConfig, signatureConfig>;
  readonly domain: TypedData.Domain;
  execute: <const name extends keyof mutationsConfig & string>(
    submitted: FFCAMutationInput<mutationsConfig, signatureConfig, name>,
  ) => Promise<FFCAMutationResult>;
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

export type { FFCAConfig, ResolvedFFCAMutationConfig } from "./config";
export type {
  FFCAMutationSchema,
  FFCASchema,
  FFCAStateSchema,
} from "./schema";
export type { KeyType } from "./signature";
export type { FFCASolidityEntrypoint } from "./sol-parse";
export type {
  BatchEvent,
  BatchStatus,
  BlockEvent,
  BlockStatus,
  FFCAMutation,
  FFCAMutationInput,
  FFCAMutationResult,
  MutationEvent,
  MutationStatus,
} from "./types";

type EntrypointMetadata<entrypoint> =
  entrypoint extends FFCASolidityEntrypoint<infer metadata>
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

export async function createFFCA<
  const entrypoint extends FFCASolidityEntrypoint,
  const sequencingConfig extends SequencingConfig = SequencingConfig,
>(
  entrypoint: entrypoint,
  config: FFCAConfig<sequencingConfig>,
): Promise<
  FFCA<
    EntrypointStorageConfig<entrypoint>,
    EntrypointMutationsConfig<entrypoint>,
    EntrypointSignatureConfig<entrypoint>,
    sequencingConfig
  >
>;
export async function createFFCA<
  const entrypoint extends FFCASolidityEntrypoint,
  const sequencingConfig extends SequencingConfig = SequencingConfig,
>(
  entrypoint: entrypoint,
  publicConfig: FFCAConfig<sequencingConfig>,
): Promise<
  FFCA<
    EntrypointStorageConfig<entrypoint>,
    EntrypointMutationsConfig<entrypoint>,
    EntrypointSignatureConfig<entrypoint>,
    sequencingConfig
  >
> {
  const app = await loadSolidityFFCAApp(entrypoint, publicConfig);
  const scope = Effect.runSync(Scope.make());
  let closed = false;

  async function closeScope() {
    if (closed) return;
    closed = true;
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }

  try {
    const typewriter = await Effect.runPromise(
      createFFCAEffect<
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
    const on = ((event, cb) => Effect.runSync(runtimeOn(event, cb))) as FFCA<
      EntrypointStorageConfig<entrypoint>,
      EntrypointMutationsConfig<entrypoint>,
      EntrypointSignatureConfig<entrypoint>,
      sequencingConfig
    >["on"];

    const execute = ((
      submitted: FFCAMutationInput<
        EntrypointMutationsConfig<entrypoint>,
        EntrypointSignatureConfig<entrypoint>
      >,
    ) => Effect.runPromise(typewriter.execute(submitted))) as FFCA<
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
      schema: typewriter.schema as unknown as FFCASchema<
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
