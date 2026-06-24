import { Data, Effect, Exit, Scope } from "effect";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { Database } from "./db";

const DEFAULT_DEPLOYMENT_LOCK_TIMEOUT_MS = 60_000;

export type DeploymentLock = {
  connection: Connection;
  scope: Scope.Closeable;
  key: bigint;
};

type DeploymentLockOptions = {
  timeoutMs?: number;
};

export class DeploymentLockConfigError extends Data.TaggedError(
  "DeploymentLockConfigError",
)<{
  readonly message: string;
}> {}

export class DeploymentLockAcquireError extends Data.TaggedError(
  "DeploymentLockAcquireError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class DeploymentLockReleaseError extends Data.TaggedError(
  "DeploymentLockReleaseError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type DeploymentLockError =
  | DeploymentLockConfigError
  | DeploymentLockAcquireError
  | DeploymentLockReleaseError;

function releaseConnectionFinalizer(
  scope: Scope.Closeable,
): Effect.Effect<void> {
  return Scope.close(scope, Exit.void).pipe(Effect.ignore);
}

function durationMs(
  value: number | undefined,
  fallback: number,
): Effect.Effect<number, DeploymentLockConfigError> {
  if (value === undefined) return Effect.succeed(fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return Effect.fail(
      new DeploymentLockConfigError({
        message: `Deployment lock timeout must be a positive safe integer (got: ${value})`,
      }),
    );
  }
  return Effect.succeed(value);
}

function acquireAdvisoryLock(
  connection: Connection,
  key: bigint,
  timeoutMs: number,
): Effect.Effect<void, DeploymentLockAcquireError> {
  const setLockTimeout = connection
    .execute(
      "SELECT set_config('lock_timeout', $1, false)",
      [`${timeoutMs}ms`],
      undefined,
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new DeploymentLockAcquireError({
            message: `failed to set Typewriter deployment lock timeout: key=${key} timeoutMs=${timeoutMs}`,
            cause,
          }),
      ),
      Effect.asVoid,
    );
  const resetLockTimeout = connection
    .execute("RESET lock_timeout", [], undefined)
    .pipe(Effect.ignore);
  const acquireLock = connection
    .execute("SELECT pg_advisory_lock($1::bigint)", [key.toString()], undefined)
    .pipe(
      Effect.mapError(
        (cause) =>
          new DeploymentLockAcquireError({
            message: `failed to acquire Typewriter deployment lock: key=${key} timeoutMs=${timeoutMs}`,
            cause,
          }),
      ),
      Effect.asVoid,
    );

  return setLockTimeout.pipe(
    Effect.andThen(acquireLock),
    Effect.ensuring(resetLockTimeout),
  );
}

export function acquireDeploymentLock(
  key: bigint,
  options: DeploymentLockOptions = {},
): Effect.Effect<DeploymentLock, DeploymentLockError, Database> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const timeoutMs = yield* durationMs(
      options.timeoutMs,
      DEFAULT_DEPLOYMENT_LOCK_TIMEOUT_MS,
    );
    const scope = yield* Scope.make();
    const connection = yield* db.$client.reserve.pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(
        (cause) =>
          new DeploymentLockAcquireError({
            message: `failed to reserve Typewriter deployment lock connection: key=${key} timeoutMs=${timeoutMs}`,
            cause,
          }),
      ),
    );
    yield* acquireAdvisoryLock(connection, key, timeoutMs).pipe(
      Effect.tapError(() => releaseConnectionFinalizer(scope)),
    );
    return { connection, scope, key };
  });
}

export function scopedDeploymentLock(
  key: bigint,
  options: DeploymentLockOptions = {},
): Effect.Effect<DeploymentLock, DeploymentLockError, Database | Scope.Scope> {
  return Effect.acquireRelease(acquireDeploymentLock(key, options), (lock) =>
    releaseDeploymentLock(lock).pipe(Effect.ignore),
  );
}

export function releaseDeploymentLock(
  lock: DeploymentLock,
): Effect.Effect<void, DeploymentLockReleaseError> {
  return Effect.gen(function* () {
    const rows = yield* lock.connection
      .execute(
        "SELECT pg_advisory_unlock($1::bigint) AS released",
        [lock.key.toString()],
        undefined,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new DeploymentLockReleaseError({
              message: `failed to release Typewriter deployment lock: key=${lock.key}`,
              cause,
            }),
        ),
      );
    const [{ released = false } = { released: false }] = rows as {
      released: boolean;
    }[];
    if (released === false) {
      return yield* new DeploymentLockReleaseError({
        message: `Typewriter deployment lock was not held: key=${lock.key}`,
      });
    }
  }).pipe(Effect.ensuring(releaseConnectionFinalizer(lock.scope)));
}
