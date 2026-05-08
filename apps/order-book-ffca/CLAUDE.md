# CLAUDE.md - order-book-ffca

Backend-only order book implementation using `ffca` as the runtime. The app owns order-book domain logic, persistence hooks, HTTP routes, and signature/account verification. Do not change `packages/ffca` from this workspace.

Nested contracts under `contracts/src` are copied from `apps/order-book-contracts/src` and should stay source-compatible unless explicitly requested.
