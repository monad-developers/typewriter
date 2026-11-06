import type { KeyType } from "../src/client";
import { EXPIRATION_MARGIN } from "../src/typewriter-constants";
import { Rng } from "./random";

/** `[value, weight]`: a draw picks a value with probability proportional to its weight. */
export type Weighted<value> = [value, number][];

/**
 * Everything about a simulation is decided by its plan, and the plan is
 * decided by the seed alone, or read from a file.
 */
export type Plan = {
  /** Seeds the run's own draws, such as each request's latency. */
  seed: string;
  /** The run fails when the runtime emits no mutation event for this much virtual time. */
  stallTimeoutMs: number;
  scheduler: {
    /** How often the scheduler jumps the clock before a pick, while tasks are ready. */
    jumpRate: number;
    /**
     * How far past now a jump moves the clock, at least to the next sleep. A
     * jump past `EXPIRATION_MARGIN` moves the next block's timestamp past
     * expirations the runtime accepted against the block before, and past the
     * delay that settlements in flight pinned, so they revert.
     */
    jumpsMs: Weighted<number>;
    /** How often the scheduler releases an in-flight I/O result before a pick, while tasks are ready. */
    ioRate: number;
  };
  chain: {
    blockTimeMs: number;
    genesisTimestamp: number;
    /** How often a block is a reorg, which replaces up to `finalizedBlockDepth` blocks. */
    reorgRate: number;
    /** How often a reorg drops a transaction of a block it replaced, with its sender's later ones. */
    dropRate: number;
    /** How often a node accepts a sent transaction and then loses it. */
    sendDropRate: number;
    /** How far below the highest head the chain finalizes. */
    finalizedBlockDepth: number;
  };
  generator: {
    /** The key type of each account. */
    accounts: (keyof typeof KeyType)[];
    mutations: number;
    /** The delays between submissions. */
    delaysMs: Weighted<number>;
    revertRate: number;
    enqueueRate: number;
    /** How often an executed step is executed again as soon as it is received. */
    resubmitRate: number;
    /**
     * The seconds from a step's submission to its authorization's expiration.
     * `-1` expires before genesis, so it always fails. The runtime rejects one
     * within `EXPIRATION_MARGIN` of the latest block, so `0` and
     * `EXPIRATION_MARGIN - 2` are rejected unless the runtime's latest block
     * is behind the clock, and `EXPIRATION_MARGIN` and above are accepted, and
     * expire if the clock jumps before they execute again. `null` never
     * expires.
     */
    expirationsS: Weighted<number | null>;
    /** How often a step enqueues bytes the contract cannot decode. */
    malformedRate: number;
    /** How often a step adds or removes a credential, and how often an `execute` signs with a later one. */
    credentialRate: number;
    /** The seconds from an `AddCredential`'s submission to its credential's expiration, as in `expirationsS`. */
    credentialExpirationsS: Weighted<number | null>;
  };
  typewriter: {
    blockPollingIntervalMs: number;
    ordering:
      | { order: "fifo" }
      | {
          order: "batch";
          batchIntervalMs: number;
          batchOrder: ["A", "B"] | ["B", "A"];
        };
  };
  transports: TransportPlan[];
  db: {
    latencyMs: [number, number];
    /** How often a transaction rolls back at a drawn statement, so the runtime runs it again. */
    errorRate: number;
  };
};

export type TransportPlan = {
  latencyMs: [number, number];
  errorRate: number;
  applyThenErrorRate: number;
  /** How far behind the chain the endpoint's view is, in virtual time. */
  lagMs: number;
  /** How often a request applies, then answers after the runtime's request timeout. */
  slowRate: number;
};

export function makePlan(seed: string): Plan {
  // Each field draws from its own generator, so a new draw shifts no other field.
  const at = (path: string) => new Rng(seed, `plan:${path}`);

  const reorgRate = at("chain.reorgRate").pick([0, 0.01, 0.05, 0.2]);
  const chain: Plan["chain"] = {
    blockTimeMs: at("chain.blockTimeMs").pick([100, 300, 400, 1_000]),
    genesisTimestamp: 1_700_000_000,
    reorgRate,
    dropRate: reorgRate === 0 ? 0 : at("chain.dropRate").pick([0, 0.05, 0.25]),
    sendDropRate: at("chain.sendDropRate").pick([0, 0.05, 0.2]),
    finalizedBlockDepth: at("chain.finalizedBlockDepth").int(1, 5),
  };

  const accounts = at("generator.accounts");
  const mutations = at("generator.mutations");
  const generator: Plan["generator"] = {
    accounts: Array.from({ length: accounts.int(1, 6) }, () =>
      accounts.pick(["Secp256k1", "P256", "WebAuthnP256"] as const),
    ),
    // A burst of a few hundred mutations outgrows the transaction gas cap
    // and splits into several settlements.
    mutations: mutations.weighted([
      [mutations.int(4, 50), 3],
      [mutations.int(51, 400), 3],
      [mutations.int(401, 2000), 1],
    ]),
    delaysMs: at("generator.delaysMs").pick([
      [[0, 1]],
      // Clumps across many blocks, so enqueues land while batches still fill.
      [
        [0, 9],
        [100, 1],
      ],
      [
        [0, 3],
        [1, 1],
      ],
      [
        [0, 1],
        [1, 1],
        [10, 1],
      ],
      [
        [0, 1],
        [50, 1],
        [500, 1],
      ],
      [
        [10, 1],
        [100, 1],
        [1_000, 1],
      ],
    ] as Weighted<number>[]),
    revertRate: at("generator.revertRate").pick([0, 0.01, 0.05, 0.1]),
    enqueueRate: at("generator.enqueueRate").pick([0, 0.01, 0.05, 0.1]),
    resubmitRate: at("generator.resubmitRate").pick([0, 0.01, 0.1, 1]),
    expirationsS: [
      [-1, 1],
      [0, 1],
      [EXPIRATION_MARGIN - 2, 1],
      [EXPIRATION_MARGIN, 1],
      [EXPIRATION_MARGIN + 2, 1],
      [null, 20],
    ],
    malformedRate: at("generator.malformedRate").pick([0, 0.01, 0.05, 0.2]),
    credentialRate: at("generator.credentialRate").pick([0, 0.01, 0.05]),
    credentialExpirationsS: [
      [-1, 1],
      [EXPIRATION_MARGIN + 2, 1],
      [EXPIRATION_MARGIN * 10, 1],
      [null, 3],
    ],
  };

  const typewriter: Plan["typewriter"] = {
    blockPollingIntervalMs: at("typewriter.blockPollingIntervalMs").pick([
      50, 200, 1_000,
    ]),
    ordering: at("typewriter.ordering").bool()
      ? { order: "fifo" }
      : {
          order: "batch",
          batchIntervalMs: at("typewriter.batchIntervalMs").pick([10, 50, 300]),
          batchOrder: at("typewriter.batchOrder").pick([
            ["A", "B"],
            ["B", "A"],
          ] as (["A", "B"] | ["B", "A"])[]),
        },
  };

  const transports = Array.from(
    {
      length: at("transports.length").weighted([
        [1, 2],
        [2, 2],
        [3, 1],
      ] as Weighted<number>),
    },
    (_, i): TransportPlan => {
      const field = (name: string) => at(`transports.${i}.${name}`);
      return {
        latencyMs: field("latencyMs").pick([
          [1, 5],
          [5, 50],
          [50, 500],
        ] as [number, number][]),
        errorRate: field("errorRate").pick([0, 0.01, 0.1]),
        applyThenErrorRate: field("applyThenErrorRate").pick([0, 0.01, 0.1]),
        lagMs: field("lagMs").pick([0, 0, 100, 1_000]),
        slowRate: field("slowRate").pick([0, 0.01, 0.05]),
      };
    },
  );

  const db: Plan["db"] = {
    latencyMs: at("db.latencyMs").pick([
      [0, 1],
      [1, 10],
      [10, 100],
    ] as [number, number][]),
    errorRate: at("db.errorRate").pick([0, 0.01, 0.05]),
  };

  return {
    seed,
    stallTimeoutMs: 300_000,
    scheduler: {
      jumpRate: at("scheduler.jumpRate").pick([0, 0.0001, 0.001]),
      // The long jump passes the latest finite expiration, `EXPIRATION_MARGIN + 2`.
      jumpsMs: [
        [0, 3],
        [(EXPIRATION_MARGIN + 3) * 1_000, 1],
      ],
      ioRate: at("scheduler.ioRate").pick([0, 0.01, 0.1]),
    },
    chain,
    generator,
    typewriter,
    transports,
    db,
  };
}
