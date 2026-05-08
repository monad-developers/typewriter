# Query Handler TODOs

The HTTP read model must not maintain ad-hoc in-memory projections. Until the Postgres query handler lands, these endpoints are intentionally degraded or unavailable:

- `/api/tps` — needs persisted mutation acceptance timestamps.
- `/api/blocks/:number` — needs persisted block/lifecycle rows.
- `/api/mutations?block=...` — needs persisted mutation-to-block projection.
- `/api/mutation?id=...` and `/api/mutation?account=...&nonce=...` — need persisted mutation lookup rows.
- `/api/account/:id` currently returns `mutations: []`; account mutation history should come from the persisted mutation query projection.

Endpoints that derive only current app state may read from `app.state` until they are switched to the Postgres query handler.
