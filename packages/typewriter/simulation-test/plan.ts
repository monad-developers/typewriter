import { KeyType } from "../src/client";
import { EXPIRATION_MARGIN } from "../src/typewriter-constants";
import { int, pick } from "./random";

export type SIM = {
  seed: string;
  /** The run fails when the runtime emits no mutation event for this much virtual time. */
  stallTimeoutMs: number;
  /** How often the scheduler jumps the clock before a pick, while tasks are ready. */
  jumpRate: number;
  /**
   * How far past now a jump moves the clock, at least to the next sleep, that
   * a jump draws from. A jump past `EXPIRATION_MARGIN` moves the next block's
   * timestamp past expirations the runtime accepted against the block before,
   * and past the delay that settlements in flight pinned, so they revert.
   */
  jumpsMs: number[];
  /** How often the scheduler releases an in-flight I/O result before a pick, while tasks are ready. */
  ioRate: number;
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
    accounts: KeyType[];
    mutations: number;
    /** The delays between submissions that a step draws from. */
    delaysMs: number[];
    revertRate: number;
    enqueueRate: number;
    /** How often an executed step is executed again as soon as it is received. */
    resubmitRate: number;
    /**
     * The seconds from a step's submission to its authorization's expiration
     * that a step draws from. `-1` expires before genesis, so it always fails.
     * The runtime rejects one within `EXPIRATION_MARGIN` of the latest block,
     * so `0` and `EXPIRATION_MARGIN - 2` are rejected unless the runtime's
     * latest block is behind the clock, and `EXPIRATION_MARGIN` and above are
     * accepted, and expire if the clock jumps before they execute again.
     * `Infinity` never expires, and repeats so most steps draw it.
     */
    expirationsS: number[];
    /** How often a step enqueues bytes the contract cannot decode. */
    malformedRate: number;
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
  transports: {
    latencyMs: [number, number];
    errorRate: number;
    applyThenErrorRate: number;
    /** How far behind the chain the endpoint's view is, in virtual time. */
    lagMs: number;
    /** How often a request applies, then answers after the runtime's request timeout. */
    slowRate: number;
  }[];
  db: {
    latencyMs: [number, number];
    /** How often a transaction rolls back at a drawn statement, so the runtime runs it again. */
    errorRate: number;
  };
};

/** The configuration of a run. Each value is drawn from `seed` and its path. */
export function makeSim(seed: string): SIM {
  return {
    seed,
    stallTimeoutMs: 300_000,
    jumpRate: pick(seed, "jumpRate", [0, 0.0001, 0.001]),
    // The long jump passes the latest finite expiration, `EXPIRATION_MARGIN + 2`.
    jumpsMs: [0, 0, 0, (EXPIRATION_MARGIN + 3) * 1_000],
    ioRate: pick(seed, "ioRate", [0, 0.01, 0.1]),
    chain: {
      blockTimeMs: pick(seed, "chain.blockTimeMs", [100, 300, 400, 1_000]),
      genesisTimestamp: 1_700_000_000,
      // TODO(kyle) restore [0, 0.01, 0.05, 0.2] with reorg handling.
      reorgRate: pick(seed, "chain.reorgRate", [0]),
      dropRate: pick(seed, "chain.dropRate", [0, 0.05, 0.25]),
      sendDropRate: pick(seed, "chain.sendDropRate", [0, 0.05, 0.2]),
      finalizedBlockDepth: int(seed, "chain.finalizedBlockDepth", 1, 5),
    },
    generator: {
      accounts: Array.from(
        { length: int(seed, "generator.accounts", 1, 6) },
        (_, i) =>
          pick(seed, `generator.accounts.${i}`, [
            KeyType.Secp256k1,
            KeyType.P256,
            KeyType.WebAuthnP256,
          ]),
      ),
      // A burst of a few hundred mutations outgrows the transaction gas cap
      // and splits into several settlements.
      mutations: int(seed, "generator.mutations", 4, 2000),
      delaysMs: pick(seed, "generator.delaysMs", [
        [0],
        // Clumps across many blocks, so enqueues land while batches still fill.
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 100],
        [0, 0, 0, 1],
        [0, 1, 10],
        [0, 50, 500],
        [10, 100, 1_000],
      ]),
      revertRate: pick(seed, "generator.revertRate", [0, 0.01, 0.05, 0.1]),
      enqueueRate: pick(seed, "generator.enqueueRate", [0, 0.01, 0.05, 0.1]),
      resubmitRate: pick(seed, "generator.resubmitRate", [0, 0.01, 0.1, 1]),
      expirationsS: [
        -1,
        0,
        EXPIRATION_MARGIN - 2,
        EXPIRATION_MARGIN,
        EXPIRATION_MARGIN + 2,
        ...Array<number>(20).fill(Infinity),
      ],
      malformedRate: pick(
        seed,
        "generator.malformedRate",
        [0, 0.01, 0.05, 0.2],
      ),
    },
    typewriter: {
      blockPollingIntervalMs: pick(
        seed,
        "typewriter.blockPollingIntervalMs",
        [50, 200, 1_000],
      ),
      ordering:
        pick(seed, "typewriter.ordering", ["fifo", "batch"]) === "fifo"
          ? { order: "fifo" }
          : {
              order: "batch",
              batchIntervalMs: pick(
                seed,
                "typewriter.ordering.batchIntervalMs",
                [10, 50, 300],
              ),
              batchOrder: pick(seed, "typewriter.ordering.batchOrder", [
                ["A", "B"],
                ["B", "A"],
              ] as (["A", "B"] | ["B", "A"])[]),
            },
    },
    transports: Array.from(
      { length: int(seed, "transports.length", 1, 3) },
      (_, i) => ({
        latencyMs: pick(seed, `transports.${i}.latencyMs`, [
          [1, 5],
          [5, 50],
          [50, 500],
        ] as [number, number][]),
        errorRate: pick(seed, `transports.${i}.errorRate`, [0, 0.01, 0.1]),
        applyThenErrorRate: pick(
          seed,
          `transports.${i}.applyThenErrorRate`,
          [0, 0.01, 0.1],
        ),
        lagMs: pick(seed, `transports.${i}.lagMs`, [0, 0, 100, 1_000]),
        slowRate: pick(seed, `transports.${i}.slowRate`, [0, 0.01, 0.05]),
      }),
    ),
    db: {
      latencyMs: pick(seed, "db.latencyMs", [
        [0, 1],
        [1, 10],
        [10, 100],
      ] as [number, number][]),
      errorRate: pick(seed, "db.errorRate", [0, 0.01, 0.05]),
    },
  };
}
