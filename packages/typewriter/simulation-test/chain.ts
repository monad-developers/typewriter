import {
  Deferred,
  Effect,
  Schedule,
  type Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import {
  makeHttpTransport,
  type RpcRequest,
  RpcResponseError,
  type RpcResult,
} from "../src/rpc-transport";
import { SIM } from "./index";

export type Chain = {
  request: <request extends RpcRequest>(
    request: request,
  ) => Effect.Effect<RpcResult<request["method"]>>;
  /** Mines one block at `timestamp`, in seconds. */
  mine: (timestamp: number) => Effect.Effect<void>;
};

export function makeChain(): Effect.Effect<
  Chain,
  never,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    // The scope kills Anvil when it closes.
    const anvil = yield* ChildProcess.make(
      "anvil",
      [
        "--network",
        "monad",
        "--port",
        "0",
        "--no-mining",
        "--timestamp",
        String(SIM.chain.genesisTimestamp),
        // TODO(kyle) remove once typewriter caps a settlement's gas. It
        // settles a whole backlog in one transaction, which can go over the
        // 30M block gas limit and fail with "intrinsic gas too high".
        "--gas-limit",
        "1000000000",
      ],
      { stderr: "inherit" },
    ).pipe(Effect.orDie);

    // Read stdout until Anvil exits, so that Anvil does not block on a full pipe.
    const listening = yield* Deferred.make<number>();
    yield* anvil.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        const match = /Listening on [\d.]+:(\d+)/.exec(line);
        return match === null
          ? Effect.void
          : Deferred.succeed(listening, Number(match[1]));
      }),
      Effect.andThen(
        Deferred.die(listening, new Error("anvil exited before it listened")),
      ),
      Effect.orDie,
      Effect.forkScoped,
    );
    const port = yield* Deferred.await(listening);

    const transport = makeHttpTransport(`http://127.0.0.1:${port}`);
    const lock = yield* Semaphore.make(1);

    const send = (request: RpcRequest) =>
      transport.request(request).pipe(
        Effect.retry({
          schedule: Schedule.exponential("10 millis"),
          times: 5,
          while: (error) => !(error instanceof RpcResponseError),
        }),
        Effect.orDie,
      );

    const request = ((request: RpcRequest) =>
      lock.withPermits(1)(send(request))) as Chain["request"];

    const mine = (timestamp: number) =>
      lock
        .withPermits(1)(
          // `PublicRpcSchema` does not include Anvil methods.
          send({
            method: "evm_mine",
            params: [{ timestamp, blocks: 1 }],
          } as unknown as RpcRequest),
        )
        .pipe(Effect.asVoid);

    return { request, mine };
  });
}
