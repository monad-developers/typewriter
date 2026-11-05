# Simulation Test

A deterministic simulation of the Typewriter runtime: a seed generates a plan (the chain, the JSON-RPC providers and their faults, the database's faults, the runtime's config and the client's workload), and the same plan reproduces the same run. A plan can also be read from a JSON file, such as `plans/quiet.json`, a typical workload without faults.

Requires Bun, Foundry (`anvil`, `forge`), the `typewriter-evm` addon (`bun run --filter typewriter-evm build`) and a Postgres server in `DATABASE_URL`.

```sh
bun simulation-test/index.ts                                    # a random seed
SEED=0x0b bun simulation-test/index.ts                          # reproduce a seed
SEED=0x0b bun simulation-test/index.ts --print-plan             # print its plan
bun simulation-test/index.ts --plan simulation-test/plans/quiet.json  # a plan from a file
SEEDS=0x01-0x40 bun simulation-test/index.ts                    # a sweep, in one process
```

Each run creates its own database, dropped when the run passes and kept for inspection when it fails. `TYPEWRITER_LOG_LEVEL=debug` shows the runtime's logs.
