# Benchmark

Requires Foundry, the `typewriter-evm` addon, and Postgres.

```sh
DATABASE_URL=postgresql://localhost:5432/postgres bun benchmark/index.ts                    # benchmark/plan.json
DATABASE_URL=postgresql://localhost:5432/postgres bun benchmark/index.ts --plan <plan.json> # a simulation plan
```
