import {
  Deferred,
  Effect,
  Schedule,
  type Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { Hex } from "ox";
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
  /**
   * Replaces the last `depth` blocks with as many new ones at `timestamp`, in
   * seconds. Block 1, where the contract is deployed, stays. Returns the
   * hashes of the blocks it replaced.
   */
  reorg: (depth: number, timestamp: number) => Effect.Effect<Hex.Hex[]>;
};

/**
 * The third Anvil account. It sends one transaction in the first block of each
 * reorg, so the new blocks never hash the same as the ones they replace.
 */
const REORG = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

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

    // A node puts the transactions of dropped blocks back in its pool. Anvil
    // drops them, and evicts any pool transaction whose nonce they precede
    // once it mines a block, so they are sent again before the first new block.
    const reorg = (depth: number, timestamp: number) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const head = Number(yield* send({ method: "eth_blockNumber" }));
          const replaced = Math.min(depth, head - 1);
          if (replaced <= 0) return [];

          const hashes: Hex.Hex[] = [];
          const raws: unknown[] = [];
          for (let number = head - replaced + 1; number <= head; number++) {
            const block = (yield* send({
              method: "eth_getBlockByNumber",
              params: [Hex.fromNumber(number), false],
            })) as { hash: Hex.Hex; transactions: Hex.Hex[] };
            hashes.push(block.hash);
            for (const hash of block.transactions) {
              raws.push(
                yield* send({
                  method: "eth_getRawTransactionByHash",
                  params: [hash],
                } as unknown as RpcRequest),
              );
            }
          }

          // `PublicRpcSchema` does not include Anvil methods.
          yield* send({
            method: "anvil_rollback",
            params: [replaced],
          } as unknown as RpcRequest);
          for (const raw of raws) {
            yield* send({
              method: "eth_sendRawTransaction",
              params: [raw as Hex.Hex],
            });
          }
          yield* send({
            method: "eth_sendTransaction",
            params: [{ from: REORG, to: REORG }],
          });
          for (let i = 0; i < replaced; i++) {
            yield* send({
              method: "evm_mine",
              params: [{ timestamp, blocks: 1 }],
            } as unknown as RpcRequest);
          }
          return hashes;
        }),
      );

    return { request, mine, reorg };
  });
}
