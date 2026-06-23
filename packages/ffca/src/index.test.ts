import { expect, test } from "bun:test";
import { anvil } from "viem/chains";
import Counter from "../test/contracts/src/Counter.sol";
import {
  SCHEDULER_ACCOUNT,
  TEST_DB_URL,
  TEST_RPC_URL,
  USER_ACCOUNT,
  USER_PRIVATE_KEY,
} from "../test/setup";
import {
  type COUNTER_MUTATIONS,
  type COUNTER_SIGNATURE_PARAMS,
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
  "Add",
  typeof COUNTER_MUTATIONS.Add,
  typeof COUNTER_SIGNATURE_PARAMS
> {
  return {
    name: "Add",
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

function startSubmitOverlapProxy(options: { readonly sendDelayMs: number }) {
  const port = getFreePort();
  const firstSendStarted = Promise.withResolvers<void>();
  let sendInFlight = false;
  let fillDuringSend = false;
  let sawFirstSend = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const body = (await request.json()) as {
        readonly id?: number | string | null;
        readonly jsonrpc?: string;
        readonly method?: string;
      };

      if (body.method === "eth_fillTransaction" && sendInFlight) {
        fillDuringSend = true;
      }

      if (body.method !== "eth_sendRawTransactionSync") {
        return fetch(TEST_RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      sendInFlight = true;
      if (sawFirstSend === false) {
        sawFirstSend = true;
        firstSendStarted.resolve();
      }

      try {
        await sleep(options.sendDelayMs);
        return await fetch(TEST_RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } finally {
        sendInFlight = false;
      }
    },
  });

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.stop(true),
    firstSendStarted: firstSendStarted.promise,
    getFillDuringSend: () => fillDuringSend,
  };
}

test("createFFCA serializes submit attempts", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
  const proxy = startSubmitOverlapProxy({ sendDelayMs: 250 });
  const config = {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: proxy.url,
    sequencing: {
      order: "batch",
      batchOrder: ["NewAccount", "Add"],
      batchIntervalMs: 100,
      submitIntervalMs: 25,
    },
    database: { url: TEST_DB_URL, maxConnections: 2 },
    blockPollingIntervalMs: 50,
  } as const satisfies FFCAConfig;

  const ffca = await createFFCA(Counter, config);

  try {
    const setupIncluded = Promise.withResolvers<void>();
    const unsubscribeSetup = ffca.on("mutation", (event) => {
      if (event.name === "NewAccount" && event.status === "included") {
        setupIncluded.resolve();
      }
    });

    await ffca.execute(
      counterNewAccountMutation({
        address: USER_ACCOUNT.address,
      }) as unknown as Parameters<typeof ffca.execute>[0],
    );
    await timeout(setupIncluded.promise, 5_000, "setup mutation timed out");
    unsubscribeSetup();

    const firstAddAccepted = Promise.withResolvers<void>();
    const unsubscribeFirstAdd = ffca.on("mutation", (event) => {
      if (
        event.name === "Add" &&
        event.status === "accepted" &&
        event.params.amount === 7n
      ) {
        firstAddAccepted.resolve();
      }
    });

    await ffca.execute(
      counterAddMutation({
        address,
        amount: 7n,
        nonce: 0n,
      }) as unknown as Parameters<typeof ffca.execute>[0],
    );
    await timeout(firstAddAccepted.promise, 5_000, "first add timed out");
    unsubscribeFirstAdd();

    await timeout(proxy.firstSendStarted, 5_000, "first submit did not start");

    const secondAddIncluded = Promise.withResolvers<void>();
    const unsubscribeSecondAdd = ffca.on("mutation", (event) => {
      if (
        event.name === "Add" &&
        event.status === "included" &&
        event.params.amount === 8n
      ) {
        secondAddIncluded.resolve();
      }
    });

    await ffca.execute(
      counterAddMutation({
        address,
        amount: 8n,
        nonce: 1n,
      }) as unknown as Parameters<typeof ffca.execute>[0],
    );
    await timeout(secondAddIncluded.promise, 5_000, "second add timed out");
    unsubscribeSecondAdd();

    expect(proxy.getFillDuringSend()).toBe(false);
  } finally {
    await ffca.close();
    proxy.close();
  }
}, 15_000);

test("createFFCA checks the receipt before retrying a failed submit", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
  const port = getFreePort();
  const fillNonces: unknown[] = [];
  let sendCount = 0;
  let failedSubmit = false;
  let receiptRequestsAfterSubmitFailure = 0;
  let shouldFailSubmit = true;

  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const body = (await request.json()) as {
        readonly id?: number | string | null;
        readonly jsonrpc?: string;
        readonly method?: string;
        readonly params?: readonly unknown[];
      };

      if (body.method === "eth_fillTransaction") {
        const transaction = body.params?.[0] as
          | { readonly nonce?: unknown }
          | undefined;
        fillNonces.push(transaction?.nonce);
      }

      if (
        body.method === "eth_getTransactionReceipt" &&
        failedSubmit &&
        sendCount === 1
      ) {
        receiptRequestsAfterSubmitFailure += 1;
      }

      if (body.method === "eth_sendRawTransactionSync" && shouldFailSubmit) {
        sendCount += 1;
        failedSubmit = true;
        shouldFailSubmit = false;
        return Response.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: {
            code: -32_000,
            message: "forced eth_sendRawTransactionSync",
          },
        });
      }

      if (body.method === "eth_sendRawTransactionSync") {
        sendCount += 1;
      }

      return fetch(TEST_RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  });
  const config = {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: `http://127.0.0.1:${port}`,
    sequencing: {
      order: "batch",
      batchOrder: ["NewAccount", "Add"],
      batchIntervalMs: 100,
      submitIntervalMs: 25,
    },
    database: { url: TEST_DB_URL, maxConnections: 2 },
    blockPollingIntervalMs: 50,
  } as const satisfies FFCAConfig;

  const ffca = await createFFCA(Counter, config);

  try {
    const setupIncluded = Promise.withResolvers<void>();
    const unsubscribeSetup = ffca.on("mutation", (event) => {
      if (event.name === "NewAccount" && event.status === "included") {
        setupIncluded.resolve();
      }
    });

    await ffca.execute(
      counterNewAccountMutation({
        address: USER_ACCOUNT.address,
      }) as unknown as Parameters<typeof ffca.execute>[0],
    );
    await timeout(setupIncluded.promise, 5_000, "setup mutation timed out");
    unsubscribeSetup();

    expect(fillNonces).toHaveLength(1);
    expect(receiptRequestsAfterSubmitFailure).toBeGreaterThan(0);
    expect(sendCount).toBe(2);
  } finally {
    await ffca.close();
    proxy.stop(true);
  }
}, 10_000);

test("createFFCA waits for the next block before submitting again", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
  const config = {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: {
      order: "batch",
      batchOrder: ["NewAccount", "Add"],
      batchIntervalMs: 100,
      submitIntervalMs: 25,
    },
    database: { url: TEST_DB_URL, maxConnections: 2 },
    blockPollingIntervalMs: 50,
  } as const satisfies FFCAConfig;

  const ffca = await createFFCA(Counter, config);

  try {
    const setupIncluded = Promise.withResolvers<void>();
    const unsubscribeSetup = ffca.on("mutation", (event) => {
      if (event.name === "NewAccount" && event.status === "included") {
        setupIncluded.resolve();
      }
    });

    await ffca.execute(
      counterNewAccountMutation({
        address: USER_ACCOUNT.address,
      }) as unknown as Parameters<typeof ffca.execute>[0],
    );
    await timeout(setupIncluded.promise, 5_000, "setup mutation timed out");
    unsubscribeSetup();

    const firstAddBlock = Promise.withResolvers<bigint>();
    const secondAddBlock = Promise.withResolvers<bigint>();
    const unsubscribeBlocks = ffca.on("block", (event) => {
      if (event.status !== "included") return;
      for (const batch of event.batches) {
        if (batch.status !== "included") continue;
        for (const mutation of batch.mutations) {
          if (mutation.name !== "Add") continue;
          if (mutation.params.amount === 7n) {
            firstAddBlock.resolve(event.number);
          }
          if (mutation.params.amount === 8n) {
            secondAddBlock.resolve(event.number);
          }
        }
      }
    });

    await ffca.execute(
      counterAddMutation({
        address,
        amount: 7n,
        nonce: 0n,
      }) as unknown as Parameters<typeof ffca.execute>[0],
    );
    const firstBlockNumber = await timeout(
      firstAddBlock.promise,
      5_000,
      "first add timed out",
    );

    await ffca.execute(
      counterAddMutation({
        address,
        amount: 8n,
        nonce: 1n,
      }) as unknown as Parameters<typeof ffca.execute>[0],
    );

    const secondBlockNumber = await timeout(
      secondAddBlock.promise,
      5_000,
      "second add timed out",
    );
    unsubscribeBlocks();

    expect(secondBlockNumber > firstBlockNumber).toBe(true);
  } finally {
    await ffca.close();
  }
}, 15_000);

test("createFFCA stops accepting mutations after fatal submit failure", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
  let failFillTransaction = false;
  const fatalError = Promise.withResolvers<unknown>();
  const proxy = startRpcProxy({
    shouldFailFillTransaction: () => failFillTransaction,
  });
  const config = {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: proxy.url,
    sequencing: {
      order: "batch",
      batchOrder: ["NewAccount", "Add"],
      batchIntervalMs: 100,
      submitIntervalMs: 25,
    },
    database: { url: TEST_DB_URL, maxConnections: 2 },
    blockPollingIntervalMs: 50,
    onFatalError: fatalError.resolve,
  } as const satisfies FFCAConfig;

  const ffca = await createFFCA(Counter, config);

  try {
    const setupIncluded = Promise.withResolvers<void>();
    const unsubscribeSetup = ffca.on("mutation", (event) => {
      if (event.name === "NewAccount" && event.status === "included") {
        setupIncluded.resolve();
      }
    });
    await ffca.execute(
      counterNewAccountMutation({
        address: USER_ACCOUNT.address,
      }) as unknown as Parameters<typeof ffca.execute>[0],
    );
    await timeout(setupIncluded.promise, 5_000, "setup mutation timed out");
    unsubscribeSetup();

    const accepted = Promise.withResolvers<void>();
    const unsubscribeAccepted = ffca.on("mutation", (event) => {
      if (event.name === "Add" && event.status === "accepted") {
        accepted.resolve();
      }
    });

    failFillTransaction = true;
    await ffca.execute(
      counterAddMutation({
        address,
        amount: 7n,
        nonce: 0n,
      }) as unknown as Parameters<typeof ffca.execute>[0],
    );
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
        counterAddMutation({
          address,
          amount: 8n,
          nonce: 1n,
        }) as unknown as Parameters<typeof ffca.execute>[0],
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
