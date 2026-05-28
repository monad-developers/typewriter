import { Effect, Exit, Scope } from "effect";
import type { TypedData } from "ox";
import type { FFCAConfig } from "./config";
import type {
  BatchListener,
  BlockListener,
  MutationListener,
  RuntimeFFCA,
} from "./ffca";
import { createFFCAEffect } from "./ffca";
import type { FFCAMutation, FFCAMutationResult } from "./types";

export type FFCA<C extends FFCAConfig> = {
  readonly state: RuntimeFFCA<C, "fifo" | "batch">["state"];
  readonly schema: RuntimeFFCA<C, "fifo" | "batch">["schema"];
  readonly domain: TypedData.Domain;
  execute(submitted: FFCAMutation): Promise<FFCAMutationResult>;
  on(event: "mutation", cb: MutationListener): () => void;
  on(event: "batch", cb: BatchListener): () => void;
  on(event: "block", cb: BlockListener<"fifo" | "batch">): () => void;
};

export type {
  FFCAConfig,
  FFCAMutationConfig,
} from "./config";
export {
  createMutationSchema,
  type FFCAMutationSchema,
  type FFCASchema,
  type FFCAStateSchema,
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

export async function createFFCA<const C extends FFCAConfig>(
  config: C,
): Promise<FFCA<C>> {
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
      state: ffca.state,
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
