import { Data, Deferred, Effect, type Scope, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { Hex } from "ox";
import { privateKeyToAccount } from "viem/accounts";
import type { DevChain } from "./config";
import { makeHttpTransport } from "./rpc-transport";

/**
 * Anvil's first default account: in `dev` mode the deployment's root,
 * scheduler, and relayer.
 */
const ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export class AnvilError extends Data.TaggedError("AnvilError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Starts Anvil, which stops when the scope closes. The runtime deploys the
 * app to it like to any chain, from Anvil's first account.
 */
export function startDevChain(): Effect.Effect<
  DevChain,
  AnvilError,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const anvil = yield* ChildProcess.make(
      "anvil",
      [
        "--network",
        "monad",
        "--port",
        "0",
        "--block-time",
        "0.25",
        // Anvil finalizes two epochs behind the latest block.
        "--slots-in-an-epoch",
        "1",
        // Keep recent history only, in memory, so a long-running chain stays
        // flat; the runtime reads state only at its start block.
        "--prune-history",
        "64",
        "--transaction-block-keeper",
        "1024",
      ],
      // Anvil reports bad flags, such as `--network` on an old Anvil, on stderr.
      { stderr: "inherit" },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new AnvilError({
            message:
              "Failed to start anvil; install Foundry from https://getfoundry.sh",
            cause,
          }),
      ),
    );

    // Read stdout until Anvil exits, so that Anvil does not block on a full pipe.
    const listening = yield* Deferred.make<string, AnvilError>();
    yield* anvil.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        const match = /Listening on ([\d.]+:\d+)/.exec(line);
        return match === null
          ? Effect.void
          : Deferred.succeed(listening, `http://${match[1]}`);
      }),
      Effect.andThen(
        Deferred.fail(
          listening,
          new AnvilError({ message: "Anvil exited before it listened" }),
        ),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    const rpcUrl = yield* Deferred.await(listening);

    const chainId = Hex.toNumber(
      yield* makeHttpTransport(rpcUrl)
        .request({ method: "eth_chainId" })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AnvilError({
                message: "Failed 'eth_chainId' request to Anvil",
                cause,
              }),
          ),
        ),
    );
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);

    yield* Effect.logInfo("Started Anvil").pipe(
      Effect.annotateLogs({
        rpc_url: rpcUrl,
        chain_id: chainId,
        account: account.address,
      }),
    );

    // Anvil's chain has no Monad hardfork schedule.
    return { account, chainId, hardfork: "MonadTen", rpcUrl };
  });
}
