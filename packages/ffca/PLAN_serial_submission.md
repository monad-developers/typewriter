# Serial Submission Plan

Working notes on why submitting many settlement transactions in a row is hard,
and a design that makes it reliable.

## Problem

The runtime settles by sending one transaction from a single scheduler EOA
(`runtime.ts` `submit`). Sending one transaction is easy. Sending a long,
back-to-back stream of them from one account is not, because every transaction
depends on the previous one's nonce being correct, and the tools we have for
learning "did the previous one land, and what nonce comes next?" are unreliable
in exactly the cases where we need them.

Three properties of the submission path combine into the difficulty:

1. `eth_sendRawTransactionSync` is opaque about whether the transaction was
   actually submitted.
2. Reliability forces us to use multiple RPC endpoints, but the chain is
   decentralized, so we cannot assume any endpoint has seen any given piece of
   data.
3. The RPC backing `eth_fillTransaction` and the one backing the send can be out
   of sync.

Individually each is survivable. Stacked, and repeated for every transaction in
a sequence, they make a single ambiguous moment corrupt every transaction that
follows it.

## Current behavior

For each submit tick, serialized by `withSubmitLock` (`runtime.ts:555`, applied
at `runtime.ts:1138` so only one transaction is in flight at a time):

1. Allocate the next nonce from a local counter seeded once at startup —
   `nextTransactionNonce` is initialized from `eth_getTransactionCount(address,
   "pending")` via `rpc.request` (a single endpoint, `rpc.ts:205-221`) and then
   incremented per submit (`nextTransactionNonce++`). The counter never
   reconciles with the chain again after startup, and its one seed read comes
   from whichever single endpoint the round-robin cursor lands on.
2. Call `eth_fillTransaction` with our `from`/`to`/`data`/`gas`/`nonce`/
   `accessList` through `rpc.request` again (`runtime.ts:891-903`) — another
   round-robin pick, possibly a different endpoint than step 1.
3. Strip the signature off the filled `raw`, re-sign locally with the scheduler
   account, and compute the hash locally with `keccak256(signed)`
   (`runtime.ts:905-916`). We control the exact bytes, so we know the hash
   before broadcast.
4. Broadcast `eth_sendRawTransactionSync` through `rpc.requestMultiplexed`
   (`runtime.ts:929-932`), which fans out to every endpoint and takes the first
   success (`rpc.ts:223-241`). Wrapped in `Effect.retry({ times:
   SUBMIT_RETRY_TIMES })`; before each re-broadcast it checks
   `eth_getTransactionReceipt(hash)` and returns early if a receipt already
   exists (`runtime.ts:918-936`).

The good instincts are already here: we sign locally so the hash is known up
front, we re-check the receipt before re-sending, and we fan the send out for
reliability. The weaknesses are that the nonce counter is seeded once from a
single possibly-stale endpoint and never reconciled afterward — so a stale seed
(e.g. at restart while a prior process's transaction is still pending) reuses a
nonce — and that "did it land?" is answered from single-endpoint reads that are
allowed to lie by omission.

> Step 1's single-endpoint nonce read has since been replaced; see
> [What's implemented](#whats-implemented). The failure-mode analysis below
> describes the diagnosis that motivated that fix.

## Failure modes

### 1. `eth_sendRawTransactionSync` is opaque

The `...Sync` method conflates two operations — "broadcast this transaction" and
"wait until it is included" — behind one call that either returns a receipt or
errors. When it errors (timeout, transport drop, fan-out where every provider
returned an error), it does not tell us which of these happened:

- the transaction never reached any node, or
- it reached the mempool and is pending, or
- it was actually included and the response was lost on the way back.

These demand opposite responses. Case one wants a re-broadcast. Cases two and
three want us to do nothing and wait, because re-deriving and re-sending risks a
nonce collision or a wasted nonce. Because the error cannot be classified, any
retry policy is guessing. The current receipt-recheck before re-broadcast
(`runtime.ts:919-926`) is the right idea, but it leans entirely on receipt reads
being trustworthy — which is failure mode 2.

### 2. Endpoints diverge (decentralization)

We need more than one endpoint for reliability, and the order-book already wires
a comma-separated failover list (`apps/order-book/src/constants.ts:15-21`,
`apps/order-book/src/index.ts:34`). But each endpoint is a different node with
its own mempool and its own view of pending and latest state. We cannot assume
any endpoint has seen any particular transaction. Consequences:

- `eth_getTransactionReceipt(hash)` returning `null` from one endpoint is **not**
  proof the transaction is absent — another endpoint may already have mined it.
  A round-robin read (`rpc.request`) asks exactly one endpoint, so the
  receipt-recheck can get a false `null` and re-broadcast something that already
  landed.
- `eth_getTransactionCount(address, "pending")` differs across endpoints
  depending on which transactions each one has in its mempool. The single-endpoint
  seed read can land on a node that hasn't seen a still-pending send and hand back
  a nonce that is already spoken for.
- On fan-out send (`requestMultiplexed`), one endpoint may accept while another
  rejects with `nonce too low` or `already known`. Those rejections are not real
  failures, but `requestMultiplexed` surfaces provider 0's error when every
  attempt errors (`rpc.ts:223-241`), which can present a "failure" while the
  transaction is in fact already mined elsewhere.

The rule this forces: no single endpoint's answer — especially a negative one —
can be treated as authoritative.

### 3. `eth_fillTransaction` and the send can be out of sync

The fill and the send may be served by different backends: explicitly via
round-robin/fan-out across our failover list, or implicitly behind one URL that
load-balances across nodes. If the fill's backend lags the send's backend, fill
computes nonce-adjacent fields from a stale view. We already pass our own
`nonce` into fill (`runtime.ts:899`), so fill does not pick the nonce — but the
counter's single seed read (failure mode 2) is what the whole local sequence is
anchored to, so a stale anchor propagates into every nonce derived from it.

Concretely: a process broadcasts transaction N and then dies (submit failures are
fatal — see *What's implemented*). A new process reseeds its counter from a
single endpoint that has not yet seen N, gets `N` back, and builds a *different*
transaction at `N`. The node still holding the prior pending N rejects the
lower-priced replacement (`an existing transaction had higher priority`), or it
is accepted as a replacement — either way the sequence is corrupted.

This is why the nonce anchor must be reconciled across endpoints, not read from
one. The scheduler knows which nonces it has signed and broadcast — that local
sequence is authoritative going forward — but the value it is anchored to has to
reflect the furthest-ahead endpoint, since `"pending"` from any single node is at
best a lagging echo of our own actions and at worst a stale guess.

### How they compound for many-in-a-row

For a single transaction these are tolerable. In a sequence they multiply:

- Throughput is capped because `...Sync` keeps each submit blocked on inclusion
  before the next can start, so latency stacks linearly.
- The natural fix — pipeline N+1 before N's receipt is globally visible — is
  impossible while the nonce is read from `"pending"`, because `"pending"` will
  not reliably reflect a not-yet-mined in-flight transaction across endpoints.
- One opaque failure (mode 1) that we cannot resolve (mode 2) leaves the local
  nonce sequence in an unknown state (mode 3), and every subsequent transaction
  inherits a wrong nonce — a cascade of `nonce too low` / `nonce too high`
  rejections or silent replacements from one ambiguous moment.

## What's implemented

The nonce-reuse path — the part of failure modes 2 and 3 that produced the
production error `an existing transaction had higher priority` — is closed. That
error was a nonce *reuse*: a stale single-endpoint `"pending"` seed (at startup
or restart) anchored the local counter below a nonce a prior process had already
broadcast, and the node still holding the earlier (higher-priced) pending
transaction rejected our lower-priced replacement at the same nonce.

Two changes landed:

- **`requestAll` on the `Rpc` service** (`rpc.ts`). Fans a request out to every
  endpoint concurrently and returns every successful response, dropping
  individual provider errors; if every provider errors it surfaces the first
  provider's error, matching `requestMultiplexed`. This is the `requestAll` half
  of rollout item 1 (the `requestAny` negative-read half is still open).

- **Local monotonic nonce** (`runtime.ts`). The seed-once `nextTransactionNonce`
  counter is replaced. `requestPendingTransactionNonce` now reads
  `eth_getTransactionCount(address, "pending")` from every endpoint via
  `requestAll` and keeps the maximum, so a lagging node cannot report a stale low
  value, and it runs every submit rather than only at startup. A
  `lastSubmittedNonce` high-water mark then clamps the result:
  `nonce = lastSubmittedNonce === undefined ? pending : max(pending, lastSubmittedNonce + 1)`.
  The mark is advanced to the chosen nonce right after signing and *before*
  broadcast, so the next submit can never reuse it.

Together these make per-process nonce allocation strictly monotonic: the
max-across-endpoints read removes the stale-read source, and the `+ 1` clamp
covers the window where a just-broadcast transaction is not yet visible as
`"pending"` anywhere.

### Why advancing before broadcast is safe today

Advancing the high-water mark before the send is confirmed could, in principle,
skip a nonce if that transaction never lands — a gap that would strand later
transactions behind it. Under the current model it cannot, because three
invariants hold together:

1. **Submit is serialized** — `withSubmitLock` (`runtime.ts:555`) runs one submit
   at a time, so submit N completes before N+1 starts.
2. **A successful submit means inclusion** — `eth_sendRawTransactionSync` only
   returns once the transaction is mined, and after the advance `submit` either
   returns that receipt or fails. There is no "advanced but not included" success
   path.
3. **A failed submit stops the loop** — `Effect.repeat` ends on failure and the
   `Effect.all` runtime program is fail-fast, so a submit failure kills the
   runtime fiber rather than issuing the next submit.

So a transaction that truly never lands fails its submit and halts the loop —
there is no follow-on submit to sit behind the gap — while a loop that keeps
running only advanced because the previous transaction was included. On restart,
`lastSubmittedNonce` reseeds from the max-across-endpoints `"pending"` read and
self-corrects.

The gap concern returns only once one of those invariants is removed: making
submit failures non-fatal (drops invariant 3) or pipelining multiple in-flight
nonces (drops invariant 1). That is exactly the point where "nonce recovery on
conflict" (§5) becomes required rather than optional, so the optimistic advance
needs no extra recovery machinery until then.

## Proposed solution

Own the nonce locally, make submission idempotent on the locally known hash, and
treat the multi-endpoint cluster as an eventually-consistent system that we
reconcile rather than trust one answer from.

### 1. Local authoritative nonce

> **Shipped as a clamp.** The implemented form (see *What's implemented*) keeps
> the per-submit `"pending"` read, but takes it across all endpoints and clamps
> it against a `lastSubmittedNonce` high-water mark. The pure counter below — no
> per-transaction `"pending"` read at all — is where §6 (pipelining) heads, once
> the per-tx read is no longer needed to stay aligned with the chain.

Replace the per-submit `"pending"` read (`runtime.ts:560-566`) with an in-memory
counter, seeded once at startup (and on recovery), then advanced locally.

```ts
let nextNonce: bigint | undefined;

const allocateNonce = Effect.gen(function* () {
  if (nextNonce === undefined) {
    nextNonce = yield* requestPendingNonceQuorum; // see §4: max across endpoints
  }
  const nonce = nextNonce;
  nextNonce += 1n;
  return nonce;
});

// If a build/sign fails before broadcast, return the nonce — submits are
// serialized, so this is safe (cf. the app-layer reserve/rollback pattern in
// apps/order-book/scripts/src/sdk.ts:89-127).
const releaseNonce = (nonce: bigint) =>
  Effect.sync(() => {
    if (nextNonce === nonce + 1n) nextNonce = nonce;
  });
```

The chain's `"pending"` count is now only a bootstrap/recovery input, never the
per-transaction source of truth.

### 2. Idempotent submission keyed on the local hash

We already know the exact bytes and therefore the hash before broadcast
(`runtime.ts:916`). Make that hash the idempotency key. For a given `(nonce,
calldata, gas)` the signed bytes — and the hash — are deterministic, so any
re-broadcast or recovery re-derives the same transaction. Broadcasting an
already-known transaction is success, not error. Classify send results:

- receipt returned → included.
- `already known` / `nonce too low` from any endpoint → the network already has
  this nonce; treat as "submitted", advance, and confirm by hash.
- transport/timeout error → **inclusion unknown**, do not rebuild; go poll by
  hash (§3/§4).

### 3. Separate broadcast from inclusion

The opacity in mode 1 comes from `...Sync` fusing broadcast with the inclusion
wait. Split them:

1. Broadcast: fan out the signed transaction to every endpoint, tolerating the
   benign rejections above.
2. Confirm: poll for inclusion by hash, reconciled across endpoints (§4).

A broadcast transport error stops meaning "unknown state," because inclusion is
determined separately and idempotently by hash. We can keep using
`eth_sendRawTransactionSync` for its latency win, but its error must route to
"go confirm," not "rebuild and resend."

### 4. Reconcile reads across endpoints

`rpc.ts` today offers round-robin-single (`request`) and race-first-success
(`requestMultiplexed`). Neither is right for negative reads, where one endpoint's
`null` must not win. Add reconciling read primitives:

```ts
// Inclusion: a receipt present on ANY endpoint counts as included.
const findReceipt = (hash: Hex) =>
  requestAny(
    { method: "eth_getTransactionReceipt", params: [hash] },
    (receipt) => receipt !== null,
  );

// Nonce recovery/bootstrap: trust the furthest-ahead endpoint.
const requestPendingNonceQuorum =
  requestAll({
    method: "eth_getTransactionCount",
    params: [address, "pending"],
  }).pipe(Effect.map((counts) => counts.reduce(maxBigInt)));
```

`requestAny` resolves as soon as one endpoint gives an affirmative answer and
only concludes "absent" after all endpoints agree across enough polls to clear
propagation lag. `requestAll`/`max` is used for nonce recovery so a lagging node
can never drag the counter backward.

### 5. Nonce recovery on conflict

When a broadcast for local `nextNonce` comes back `nonce too low` everywhere, or
a transaction is stuck with no receipt past the propagation window, resync:
read pending across all endpoints (`requestPendingNonceQuorum`), reconcile with
the set of hashes we have already broadcast, and either advance the local counter
(our transaction was actually included — confirm by hash) or fill a gap. This is
the "nonce recovery on conflict" item named as unbuilt under **Scheduler key
management** in `AGENTS.md`.

### 6. Pipelining (the throughput payoff)

With a local nonce (§1) and hash-keyed idempotent confirmation (§2/§3), the
submit loop no longer has to be strictly serial. Nonce allocation and signing
must be serialized, but the inclusion wait does not: sign and broadcast N+1 while
N is still confirming, because the next nonce no longer depends on N's receipt
being globally visible. Confirmation becomes an out-of-band reconciler that
advances included/safe/finalized state. `withSubmitLock` (`runtime.ts:555`)
narrows from "one transaction in flight, fully confirmed" to "one nonce
allocation + sign at a time." This is the actual answer to "many in a row":
inclusion latency leaves the critical path.

## Required code changes (rollout)

1. Add `requestAny` (first affirmative, with an all-agree negative) and
   `requestAll` to `packages/ffca/src/rpc.ts`, alongside `request` and
   `requestMultiplexed`. **`requestAll` done; `requestAny` still open.**
2. Add a local nonce manager (allocate / release / resync) in
   `packages/ffca/src/runtime.ts`, seeded via `requestPendingNonceQuorum`.
   Replace `requestPendingTransactionNonce` on the hot path. **Shipped as the
   max-across-endpoints read plus the `max(pending, last + 1)` clamp;
   allocate/release/resync still open.**
3. Route send errors through result classification (§2); use `findReceipt` for
   the receipt-recheck instead of round-robin `rpc.request`
   (`runtime.ts:919-926`).
4. Split broadcast from confirmation; keep `...Sync` as an optimization whose
   error means "confirm," not "rebuild."
5. Narrow `withSubmitLock` to nonce-allocation + sign, and move confirmation to a
   reconciler so submits can pipeline.
6. Define the accepted-but-not-confirmed lifecycle (retry forever / mark failed /
   dead-letter) — the **Runtime failure policy** item in `AGENTS.md`.

## Non-goals

- Multiple scheduler EOAs / parallel nonce lanes for settlement. This plan keeps
  the single scheduler address and makes its serial stream reliable first.
- KMS / remote signer work. Local signing stays as-is here; only nonce ownership
  and confirmation change.
- Changing the contract or mutation-batching semantics. `execute` calldata and
  batching are unchanged.

## Open decisions

- How many polls / how long is "all endpoints agree absent" before a transaction
  is declared dropped? This must exceed realistic propagation lag without
  stalling the pipeline.
- On resync, is a deliberate filler/no-op transaction acceptable to close a nonce
  gap, or must gaps only ever be resolved by observation?
- How deep should pipelining go — a bounded window of in-flight nonces, or one
  gated by sub-block confirmation timing?
- Should the local nonce counter persist across restarts, or is reseeding from
  `requestPendingNonceQuorum` plus hash reconciliation always sufficient?
- Does `requestAny`'s negative path need a minimum endpoint count to be
  meaningful (a single configured URL gives no cross-endpoint signal)?
