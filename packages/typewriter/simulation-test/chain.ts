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
  type RpcResult,
} from "../src/rpc-transport";
import { SIM } from "./index";

export type Chain = {
  request: <request extends RpcRequest>(
    request: request,
  ) => Effect.Effect<RpcResult<request["method"]>>;
  /** Mines one block, `blockTimeMs` after the previous block. */
  mine: Effect.Effect<void>;
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
        }),
        Effect.orDie,
      );

    const request = ((request: RpcRequest) =>
      lock.withPermits(1)(send(request))) as Chain["request"];

    let elapsedMs = 0;
    const mine = lock
      .withPermits(1)(
        Effect.suspend(() => {
          elapsedMs += SIM.chain.blockTimeMs;
          // Anvil takes whole seconds, so blocks in the same second share a timestamp.
          const timestamp =
            SIM.chain.genesisTimestamp + Math.floor(elapsedMs / 1000);
          // `PublicRpcSchema` does not include Anvil methods.
          return send({
            method: "evm_mine",
            params: [{ timestamp, blocks: 1 }],
          } as unknown as RpcRequest);
        }),
      )
      .pipe(Effect.asVoid);

    return { request, mine };
  });
}
