import { Data, Duration, Effect, Schedule, type Scope } from "effect";
import { AbiParameters, type Address, Hex } from "ox";
import { privateKeyToAccount } from "viem/accounts";
import type { DevChain } from "./config";
import { makeHttpTransport, type RpcRequest } from "./rpc-transport";

/** Anvil's first default account: the deployer and scheduler in `dev` mode. */
const ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** Anvil mines on a timer, so block numbers and timestamps move while idle. */
const ANVIL_BLOCK_TIME_S = 1;
const DEPLOY_TIMEOUT = Duration.seconds(30);

export class AnvilError extends Data.TaggedError("AnvilError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Starts Anvil and deploys the app to it, with Anvil's first account as the
 * scheduler. Anvil stops when the scope closes, or when the process exits.
 */
export function startDevChain(
  bytecode: Hex.Hex,
): Effect.Effect<DevChain, AnvilError, Scope.Scope> {
  return Effect.gen(function* () {
    const rpcUrl = yield* startAnvil();
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

    // Anvil unlocks its default accounts, so it signs the deployment itself.
    const hash = yield* request({
      method: "eth_sendTransaction",
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
    const receipt = yield* request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced(Duration.millis(100)),
        until: (receipt) => receipt !== null,
      }),
      Effect.timeoutOrElse({
        duration: DEPLOY_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AnvilError({
              message: `Deployment ${hash} was not mined in ${Duration.format(DEPLOY_TIMEOUT)}`,
            }),
          ),
      }),
    );
    if (receipt?.status !== "0x1" || receipt.contractAddress == null) {
      return yield* new AnvilError({
        message: `Deployment ${hash} reverted; the constructor must accept the scheduler`,
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

/** Starts Anvil on a free port, and returns its RPC URL. */
function startAnvil(): Effect.Effect<string, AnvilError, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.try({
      try: () => spawnAnvil(),
      catch: (cause) =>
        new AnvilError({
          message:
            "Failed to start anvil; install Foundry from https://getfoundry.sh",
          cause,
        }),
    }),
    ({ stop }) => Effect.promise(stop),
  ).pipe(
    Effect.flatMap(({ listening }) =>
      Effect.tryPromise({
        try: () => listening,
        catch: (cause) =>
          new AnvilError({
            message: `Anvil exited before it listened: ${String(cause)}`,
            cause,
          }),
      }),
    ),
  );
}

function spawnAnvil(): {
  listening: Promise<string>;
  stop: () => Promise<void>;
} {
  const anvil = Bun.spawn(
    [
      "anvil",
      "--network",
      "monad",
      "--port",
      "0",
      "--block-time",
      String(ANVIL_BLOCK_TIME_S),
    ],
    // Anvil reports bad flags, such as `--network` on an old Anvil, on stderr.
    { stdout: "pipe", stderr: "inherit" },
  );

  // The scope stops Anvil. A process that exits without closing it, such as
  // with `process.exit`, still kills Anvil, which would otherwise outlive it.
  const kill = () => anvil.kill();
  process.on("exit", kill);

  const stop = async () => {
    process.off("exit", kill);
    kill();
    await anvil.exited;
  };

  // Read stdout until Anvil exits, so that Anvil does not block on a full
  // pipe. Breaking out of a `for await` would cancel the stream instead.
  const reader = anvil.stdout.getReader();
  const drain = async () => {
    while (!(await reader.read()).done);
  };
  const listening = (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`exit code ${await anvil.exited}`);
      buffered += decoder.decode(value, { stream: true });
      const match = /Listening on ([\d.]+:\d+)/.exec(buffered);
      if (match !== null) {
        void drain();
        return `http://${match[1]}`;
      }
    }
  })();

  return { listening, stop };
}
