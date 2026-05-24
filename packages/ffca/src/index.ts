import { Effect, Exit, Scope } from "effect";
import type { FFCAConfig } from "./config";
import type {
  BlockListener,
  BundleListener,
  MutationListener,
  RuntimeFFCA,
} from "./ffca";
import { createFFCAEffect } from "./ffca";
import type { MutationEvent, SubmittedMutation } from "./types";

export type FFCA<C extends FFCAConfig> = {
  readonly state: RuntimeFFCA<C>["state"];
  readonly schema: RuntimeFFCA<C>["schema"];
  readonly domain: RuntimeFFCA<C>["domain"];
  execute(submitted: SubmittedMutation): Promise<MutationEvent>;
  on(event: "mutation", cb: MutationListener): () => void;
  on(event: "bundle", cb: BundleListener): () => void;
  on(event: "block", cb: BlockListener): () => void;
  stop(): Promise<void>;
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
  BlockEvent,
  BlockStatus,
  BundleEvent,
  BundleStatus,
  MutationEvent,
  MutationStatus,
  SubmittedMutation,
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
      event: "mutation" | "bundle" | "block",
      cb: unknown,
    ) => Effect.Effect<() => void>;
    const on = ((event, cb) =>
      Effect.runSync(runtimeOn(event, cb))) as FFCA<C>["on"];

    return {
      get state() {
        return ffca.state;
      },
      schema: ffca.schema,
      domain: ffca.domain,
      execute: (submitted) => Effect.runPromise(ffca.execute(submitted)),
      on,
      stop: async () => {
        await closeScope();
      },
    };
  } catch (error) {
    await closeScope();
    throw error;
  }
}
