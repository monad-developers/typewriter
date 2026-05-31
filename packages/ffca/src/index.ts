import type { AbiParameter, AbiParametersToPrimitiveTypes } from "abitype";
import { Effect, Exit, Scope } from "effect";
import type { TypedData } from "ox";
import type { StorageLayout, StorageProxy } from "storage-layout";
import type {
  FFCAConfig,
  MutationConfig,
  MutationsConfig,
  SequencingConfig,
  SignatureConfig,
  StorageConfig,
} from "./config";
import type {
  BatchListener,
  BlockListener,
  MutationListener,
} from "./ffca";
import { createFFCAEffect } from "./ffca";
import type { FFCAMutation, FFCAMutationResult } from "./types";
import type { FFCASchema } from "./schema";

export type FFCA<
  storageConfig extends StorageConfig = StorageConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = {
  readonly state: StorageProxy<storageConfig, true>;
  readonly schema: FFCASchema<mutationsConfig>;
  readonly domain: TypedData.Domain;
  execute<name extends keyof mutationsConfig & string>(
    submitted: FFCAMutation<name, mutationsConfig[name], signatureConfig>
  ): Promise<FFCAMutationResult<mutationsConfig[name]>>;
  on(event: "mutation", cb: MutationListener): () => void;
  on(event: "batch", cb: BatchListener): () => void;
  on(event: "block", cb: BlockListener<"fifo" | "batch">): () => void;
};

export type {
  FFCAConfig,
  FFCAMutationConfig,
} from "./config";
export type {
  FFCAMutationSchema,
  FFCASchema,
  FFCAStateSchema,
} from "./schema";
export type { KeyType } from "./signature";
export { verifySignature } from "./signature";
export type {
  BatchEvent,
  BatchStatus,
  BlockEvent,
  BlockStatus,
  FFCAMutation,
  MutationEvent,
  MutationStatus,
} from "./types";

export async function createFFCA<
  const storageConfig extends StorageConfig,
  const mutationsConfig extends MutationsConfig,
  const signatureConfig extends SignatureConfig,
  const sequencingConfig extends SequencingConfig,
>(
  config: FFCAConfig<
    storageConfig,
    mutationsConfig,
    signatureConfig,
    sequencingConfig
  >,
): Promise<
  FFCA<storageConfig, mutationsConfig, signatureConfig, sequencingConfig>
> {
  const scope = Effect.runSync(Scope.make());
  let closed = false;

  async function closeScope() {
    if (closed) return;
    closed = true;
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }

  try {
    const ffca = await Effect.runPromise(
      createFFCAEffect(config).pipe(Effect.provideService(Scope.Scope, scope)),
    );

    const runtimeOn = ffca.on as unknown as (
      event: "mutation" | "batch" | "block",
      cb: unknown,
    ) => Effect.Effect<() => void>;
    const on = ((event, cb) =>
      Effect.runSync(runtimeOn(event, cb))) as FFCA<C>["on"];

    return {
      // @ts-expect-error
      state: ffca.state,
      // @ts-expect-error
      schema: ffca.schema,
      domain: ffca.domain,
      execute: (submitted) => Effect.runPromise(ffca.execute(submitted)),
      on,
    };
  } catch (error) {
    await closeScope();
    throw error;
  }
}
