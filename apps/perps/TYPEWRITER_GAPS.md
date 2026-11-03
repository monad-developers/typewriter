# Where Typewriter falls short for a perps exchange

Building this app hit the gaps below, ordered by how much each one weakened the design. Each says what broke, what the app does instead, and what I'd change in Typewriter.

## 1. Liquidations always land at least one batch after the price move

The liquidator reacts to `app.on("batch", accepted)`, signs a `Liquidate`, and calls `execute`, which queues it for the **next** batch. Typewriter has no way to add mutations to a batch based on the state that batch produced, and `batchOrder` sorts by mutation name only.

So an oracle update in batch N, and every `MarketOrder` in batch N, execute against accounts that are already underwater. `Liquidate` reaches them in N+1 at the earliest. It sorts after N+1's `SetOraclePrices`, `CancelOrder`, and `LimitOrder`, and it only makes N+1 if the scan enqueues it before the next batch tick. (In `scripts/liquidation.ts` the trader kept $935 of $988 mostly because the dev maker requotes every 2s, so its bids were stale. A same-batch liquidation would have hit the same quotes.)

**What I'd change:** a sequencing hook that runs after each batch executes locally and returns follow-up mutations for the same submission (`sequencing.afterBatch: (state) => mutations[]`). Those would be server-authored mutations (see 3), so they wouldn't need signatures. This is the one gap I'd fix first: inline liquidation is the reason to put perps on a sequencer you control.

## 2. Contracts can't read time, so funding and oracle freshness are trusted to the admin

`block.timestamp` may only be used in reverting checks (README, Determinism). Funding needs elapsed time, so `funding.ts` measures it with `Date.now()` and pushes a per-lot amount through `AccrueFunding`. The contract can't check that amount. For the same reason it can't store an oracle timestamp, so it can't refuse to trade on a stale price: if the oracle loop dies, `MarketOrder` keeps filling and `Liquidate` keeps firing at the last price.

**What I'd change:** do the deferred option from the determinism work: each batch carries a server timestamp that the contract bounds against `block.timestamp` (for example `|batchTime − block.timestamp| ≤ 30s`), exposed to `execute` like `accountID`. Then funding accrues onchain from time, and oracle prices carry a timestamp the contract can check for staleness.

## 3. There is no server or system identity, so every admin action is a signed user mutation

`msg.sender` is banned and `dispatch` only receives the signer's `accountID`, so the scheduler can't act as itself. The app gives the server its own secp256k1 account (`admin.ts`), creates it, and signs every oracle push, funding accrual, deposit, and liquidation. That means:

- Each one pays for `ecrecover` and a nonce write onchain. At one oracle push per second, that is pure overhead.
- The server has to manage a key and nonce lanes. `admin.ts` uses a random lane per mutation so concurrent pushes don't block each other.
- These mutations sit in the same tables and permission bitset as user ones.

**What I'd change:** a built-in "system" origin: mutations the scheduler submits without an authorization, which reach `execute` with a reserved `accountID` (such as `bytes32(uint256(1))`) and can't be force-included. Admin checks become `accountID == SYSTEM`, and the hook in 1 can use it.

## 4. Nothing can be configured at deploy time, and constructor writes to `state` diverge silently

Every app must take exactly `constructor(address scheduler)`. That leaves no way to pass the admin account, collateral token, or initial markets. Writing them in the constructor body is worse: `createRuntimeState` (`typewriter.ts`) seeds revm only from slots persisted in Postgres, and a fresh deployment has none. Anything the constructor stores exists onchain but not offchain, and the parser doesn't reject it.

The app works around this with `SetAdmin`, which lets the first caller claim the seat. On a public deployment, anyone who gets a `SetAdmin` in before the server, including through force inclusion, takes the exchange.

**What I'd change:** the parser should reject constructor writes to `state`, since they always diverge, and Typewriter should support an `initialize` mutation that only the scheduler can submit, once, at deployment (or the system origin from 3).

## 5. Mutations can't move tokens, so deposits and withdrawals are an honor system

External calls are banned, so `Deposit` can't `transferFrom` collateral and `Withdrawal` can't pay out. `Deposit` is admin-only and stands in for a bridge that attests transfers. `Withdrawal` only debits the ledger, and its rows in `withdrawal_mutations` serve as the payout queue someone has to process outside the app. Users' collateral is only as safe as the admin. That undercuts the README's claim that "the server ... does not control user funds".

**What I'd change:** a Typewriter-owned vault for one token: an `enqueue`-like `deposit(accountID, amount)` entry point that credits app state through a reserved mutation, and withdrawals whose `execute` writes to an outbox that the base contract pays from after settlement. This needs design work. I'd do it after 1–3.

## 6. Liquidation logic has to be written twice

`Liquidate` reverts unless `health()` says the account is below maintenance, but the server can't call `health()`: the app contract may not have public functions, and the handle has no `call`/`simulate` against local state. `read.ts` reimplements `health`, `worstCaseSize`, and rounding in TypeScript. If the two drift, the liquidator either misses accounts or spams rejected `Liquidate`s, and nothing catches it. The same gap means a client can't get a quote such as "would this order pass margin?" without submitting it.

**What I'd change:** `app.call(libraryFunction, args)` (or `app.simulate(mutation)`) running a view against the local revm, with results decoded from the ABI. The determinism check already walks the same functions.

## 7. Mutations return nothing

`execute` must return nothing, and `typewriter.execute` resolves to `{ executionIndex }` only. A `LimitOrder` caller can't learn its `orderId`; it has to read its orders back from state and guess which one is new. The same goes for fill quantity and average price for a `MarketOrder`.

**What I'd change:** allow `execute` to return ABI-encodable values, or emit events, and surface them on the `accepted` mutation event and the `execute` result.

## 8. A mutation's gas is unbounded offchain

revm runs with unlimited gas, and there's no cap per mutation or per submission (the TODO at `typewriter.ts:1399`). `MarketOrder` and `Liquidate` loop over price levels and makers, so a large order against a fragmented book can be accepted offchain and then exceed the block gas limit when it settles. Typewriter then drops it, along with the rest of the settlement. The app doesn't bound its loops yet; a production version would cap levels or makers per fill.

**What I'd change:** per-mutation gas limit in config, enforced in revm, so an expensive mutation is rejected instead of accepted and later dropped.

## 9. Finding liquidatable accounts means scanning everyone

There's no feed of which storage keys a batch touched. Every oracle update changes every account's health, so the liquidator calls `Object.keys(app.state.accounts)` and recomputes health for all of them after every batch. That's fine for a demo and quadratic in practice.

**What I'd change:** a slot-diff on the `batch` event, which apps can map to touched accounts. Perps would still need an index from market to accounts with positions, which it could keep onchain.

## Smaller issues

- **Generic signing helpers need a cast.** `sign(name, params)` generic over the mutation name returns `AuthorizedMutation<Manifest, name>`, which isn't assignable to `app.execute`'s union input (`admin.ts`).
- **Types exist only after the first run.** `Perps.sol.d.ts` is written when the runtime builds the contract, so a fresh app typechecks as `unknown` until it has booted once.
- **Permissions are per mutation type.** A trading session key can be denied `Withdrawal`, but it can't be limited to one market or a maximum size.
