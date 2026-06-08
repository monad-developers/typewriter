import { expect, test } from "bun:test";
import { anvil } from "viem/chains";
import {
  SCHEDULER_ACCOUNT,
  TEST_CLIENT,
  TEST_DB_URL,
  TEST_RPC_URL,
  TEST_WALLET_CLIENT,
  USER_ACCOUNT,
  USER_PRIVATE_KEY,
} from "../test/setup";
import {
  COUNTER_DOMAIN,
  COUNTER_MUTATIONS,
  COUNTER_SIGNATURE_PARAMS,
  COUNTER_STORAGE_LAYOUT,
  counterNewAccountMutation,
  deployCounter,
  signCounter,
} from "../test/utils";
import { createFFCA, type FFCAConfig, type FFCAMutation } from "./index";

function counterAddMutation(params: {
  readonly address: `0x${string}`;
  readonly amount: bigint;
  readonly nonce: bigint;
}): FFCAMutation<
  "add",
  typeof COUNTER_MUTATIONS.add,
  typeof COUNTER_SIGNATURE_PARAMS
> {
  return {
    name: "add",
    params: { amount: params.amount, nonce: params.nonce },
    signature: signCounter({
      privateKey: USER_PRIVATE_KEY,
      amount: params.amount,
      nonce: params.nonce,
      address: params.address,
      chainId: anvil.id,
    }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort(): number {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = server;
  server.stop(true);
  return port;
}

function timeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(message);
    }),
  ]);
}

function startRpcProxy(options: {
  readonly shouldFailFillTransaction: () => boolean;
}) {
  const port = getFreePort();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const body = (await request.json()) as {
        readonly id?: number | string | null;
        readonly jsonrpc?: string;
        readonly method?: string;
      };

      if (
        body.method === "eth_fillTransaction" &&
        options.shouldFailFillTransaction()
      ) {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32_000, message: "forced eth_fillTransaction" },
        });
      }

      return fetch(TEST_RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  });

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.stop(true),
  };
}

async function observeSettlement<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<
  | { readonly status: "resolved" }
  | { readonly status: "rejected"; readonly error: unknown }
  | { readonly status: "timed-out" }
> {
  return Promise.race([
    promise.then(
      () => ({ status: "resolved" }) as const,
      (error) => ({ status: "rejected", error }) as const,
    ),
    sleep(timeoutMs).then(() => ({ status: "timed-out" }) as const),
  ]);
}

test("createFFCA keeps accepting mutations after external submitter transaction", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
  const fatalErrors: unknown[] = [];
  const config = {
    address,
    domain: COUNTER_DOMAIN,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: {
      order: "batch",
      batchOrder: ["newAccount", "add"],
      batchIntervalMs: 250,
      submitIntervalMs: 25,
    },
    database: { url: TEST_DB_URL, maxConnections: 2 },
    blockPollingIntervalMs: 50,
    onFatalError: (error) => {
      fatalErrors.push(error);
    },
    mutations: COUNTER_MUTATIONS,
  } as const satisfies FFCAConfig;

  const ffca = await createFFCA<
    typeof COUNTER_STORAGE_LAYOUT,
    typeof COUNTER_MUTATIONS,
    typeof COUNTER_SIGNATURE_PARAMS
  >(config);

  try {
    const setupIncluded = Promise.withResolvers<void>();
    const unsubscribe = ffca.on("mutation", (event) => {
      if (event.name === "newAccount" && event.status === "included") {
        setupIncluded.resolve();
      }
    });
    await ffca.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
    );
    await setupIncluded.promise;
    unsubscribe();

    await TEST_WALLET_CLIENT.sendTransaction({
      account: SCHEDULER_ACCOUNT,
      chain: anvil,
      to: USER_ACCOUNT.address,
      value: 1n,
    });
    await TEST_CLIENT.mine({ blocks: 1 });

    await ffca.execute(counterAddMutation({ address, amount: 7n, nonce: 0n }));

    const pendingResult = await observeSettlement(
      ffca.execute(counterAddMutation({ address, amount: 8n, nonce: 1n })),
      1_000,
    );

    expect(pendingResult.status).toBe("resolved");

    const finalIncluded = Promise.withResolvers<void>();
    const unsubscribeFinal = ffca.on("mutation", (event) => {
      if (event.id === 3 && event.status === "included") {
        finalIncluded.resolve();
      }
    });
    const futureResult = await observeSettlement(
      ffca.execute(counterAddMutation({ address, amount: 9n, nonce: 2n })),
      1_000,
    );

    expect(futureResult.status).toBe("resolved");
    await timeout(finalIncluded.promise, 5_000, "final mutation timed out");
    unsubscribeFinal();
    expect(fatalErrors).toHaveLength(0);
  } finally {
    await ffca.close();
  }
});

test("createFFCA stops accepting mutations after fatal submit failure", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
  let failFillTransaction = false;
  const fatalError = Promise.withResolvers<unknown>();
  const proxy = startRpcProxy({
    shouldFailFillTransaction: () => failFillTransaction,
  });
  const config = {
    address,
    domain: COUNTER_DOMAIN,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: proxy.url,
    sequencing: {
      order: "batch",
      batchOrder: ["newAccount", "add"],
      batchIntervalMs: 100,
      submitIntervalMs: 25,
    },
    database: { url: TEST_DB_URL, maxConnections: 2 },
    blockPollingIntervalMs: 50,
    onFatalError: fatalError.resolve,
    mutations: COUNTER_MUTATIONS,
  } as const satisfies FFCAConfig;

  const ffca = await createFFCA<
    typeof COUNTER_STORAGE_LAYOUT,
    typeof COUNTER_MUTATIONS,
    typeof COUNTER_SIGNATURE_PARAMS
  >(config);

  try {
    const setupIncluded = Promise.withResolvers<void>();
    const unsubscribeSetup = ffca.on("mutation", (event) => {
      if (event.name === "newAccount" && event.status === "included") {
        setupIncluded.resolve();
      }
    });
    await ffca.execute(
      counterNewAccountMutation({ address: USER_ACCOUNT.address }),
    );
    await timeout(setupIncluded.promise, 5_000, "setup mutation timed out");
    unsubscribeSetup();

    const accepted = Promise.withResolvers<void>();
    const unsubscribeAccepted = ffca.on("mutation", (event) => {
      if (event.name === "add" && event.status === "accepted") {
        accepted.resolve();
      }
    });

    failFillTransaction = true;
    await ffca.execute(counterAddMutation({ address, amount: 7n, nonce: 0n }));
    await timeout(accepted.promise, 1_000, "mutation was not accepted");
    unsubscribeAccepted();

    const error = await timeout(
      fatalError.promise,
      8_000,
      "fatal submit failure timed out",
    );
    let rejected: unknown;
    try {
      await ffca.execute(
        counterAddMutation({ address, amount: 8n, nonce: 1n }),
      );
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBe(error);
  } finally {
    await ffca.close();
    proxy.close();
  }
}, 15_000);
