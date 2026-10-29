import { Data, Deferred, Duration, Effect, type Scope, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { AbiParameters, type Address, Hex } from "ox";
import { parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DevChain } from "./config";
import { makeHttpTransport, type RpcRequest } from "./rpc-transport";

/** Anvil's first default account: the deployer and scheduler in `dev` mode. */
const ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const DEPLOY_TIMEOUT = Duration.seconds(30);

export class AnvilError extends Data.TaggedError("AnvilError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Starts Anvil and deploys the app to it, with Anvil's first account as the
 * scheduler. Anvil stops when the scope closes.
 */
export function startDevChain(
  bytecode: Hex.Hex,
): Effect.Effect<
  DevChain,
  AnvilError,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const anvil = yield* ChildProcess.make(
      "anvil",
      ["--network", "monad", "--port", "0", "--block-time", "0.25"],
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

    const transport = makeHttpTransport(rpcUrl);
    const request = <request extends RpcRequest>(request: request) =>
      transport.request(request).pipe(
        Effect.mapError(
          (cause) =>
            new AnvilError({
              message: `Failed '${request.method}' request to Anvil`,
              cause,
            }),
        ),
      );

    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
    const chainId = Hex.toNumber(yield* request({ method: "eth_chainId" }));

    // Anvil fills the nonce, gas, and fees, and signs with its own copy of the
    // key; the account signs again, so the deployment does not rely on Anvil
    // unlocking it.
    const filled = yield* request({
      method: "eth_fillTransaction",
      params: [
        {
          from: account.address,
          data: Hex.concat(
            bytecode,
            AbiParameters.encode(AbiParameters.from(["address"]), [
              account.address,
            ]),
          ),
        },
      ],
    });
    const transaction = parseTransaction(filled.raw);
    delete transaction.r;
    delete transaction.s;
    delete transaction.v;
    delete transaction.yParity;
    const signed = yield* Effect.tryPromise({
      try: () => account.signTransaction(transaction),
      catch: (cause) =>
        new AnvilError({ message: "Failed to sign the deployment", cause }),
    });

    const receipt = yield* request({
      method: "eth_sendRawTransactionSync",
      params: [signed],
    }).pipe(
      Effect.timeoutOrElse({
        duration: DEPLOY_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AnvilError({
              message: `Deployment was not mined in ${Duration.format(DEPLOY_TIMEOUT)}`,
            }),
          ),
      }),
    );
    if (receipt.status !== "0x1" || receipt.contractAddress == null) {
      return yield* new AnvilError({
        message: `Deployment ${receipt.transactionHash} reverted; the constructor must accept the scheduler`,
      });
    }
    const address: Address.Address = receipt.contractAddress;

    yield* Effect.logInfo("Started Anvil and deployed the app").pipe(
      Effect.annotateLogs({
        rpc_url: rpcUrl,
        chain_id: chainId,
        address,
        scheduler: account.address,
      }),
    );

    // Anvil's chain has no Monad hardfork schedule.
    return { address, account, chainId, hardfork: "MonadTen", rpcUrl };
  });
}
