# Pixel War

A shared 128×128 canvas where four teams fight for pixels. Sign up with a
passkey, get assigned to the smallest team, and paint — no wallet, no gas, no
seed phrase. Every action is a signed Typewriter mutation that the server accepts
in milliseconds and settles onchain in batches.

The point of the app is the **batch order**. Every 50ms the server gathers the
mutations it has received into one tick and sorts them by type:

```
AdvanceEpoch → Shield → Paint → Bomb
```

So inside a single tick:

- **Defense beats offense.** A shield placed in the same instant an enemy paints
  your pixel resolves first and absorbs the hit.
- **Bombs bury paints.** A bomb runs after every paint in the tick, so paints
  landing in that same tick are overwritten — except where a shield ate the blast.
- **The epoch rollover lands first.** A paint arriving in the same tick as the
  epoch change already sees its refilled energy.

Nobody wins those races by being a few milliseconds faster or by paying more gas.
The application's own ordering rule decides, and it is the same rule offchain and
onchain.

## Rules

| Action | Energy | Effect |
|---|---|---|
| `Paint` | 1 | Takes one pixel in one of your team's three shades. |
| `Shield` | 3 | Stacks an absorb charge (max 3) on a pixel your team already holds. |
| `Bomb` | 10 | Repaints the 3×3 around a pixel, clipped at the edges. |

Each account gets 30 energy per epoch, refilled lazily on its first action in a
new epoch. Painting a shielded pixel spends your energy and one of its shield
charges but leaves the color alone — chewing through shields is the cost of taking
defended ground.

## Determinism, and why the game looks like this

The runtime executes mutations offchain before they settle, so anything that
cannot be reproduced identically in both places is off limits: no `PREVRANDAO`,
no `COINBASE`, no `BLOCKHASH`, and stored values derived from `block.timestamp`
would drift between the server's execution and the block that eventually contains
it. Two design choices fall straight out of that:

- **Shields absorb hits instead of expiring.** A shield is a counter, not a
  deadline, so it needs no clock.
- **Epochs advance through a mutation.** `AdvanceEpoch` is signed by the epoch
  authority (an ordinary app account whose key lives on the server) and bumps
  `state.epoch` by one. Energy accounting compares stored epochs, so it is pure
  state arithmetic. `block.timestamp` is only ever used for coarse checks —
  signature deadlines and key expiry — never written into state.

- **Team assignment needs no randomness.** New players join whichever team has
  the fewest players, ties to the lowest index. Deterministic and self-balancing.

## Storage

The canvas is 16,384 pixels at four bits of color each, packed 64 to a word:

```solidity
uint256[256] canvas;                 // 128 * 128 pixels, 4 bits each
mapping(uint32 => uint8) shields;    // sparse: most pixels are never shielded
uint32[4] teamPixels;                // live scores, one slot
```

A paint writes exactly one storage slot, and a full-canvas read is 256 slot reads
rather than 16,384. Color 0 is bare canvas; colors 1–12 are four teams of three
shades, so a pixel's team is implied by its color and never needs its own storage.

Attribution is not stored at all. "Who painted this pixel?" is answered from the
`paint_mutations` table Typewriter generates, which is also what backs the
leaderboard and the time-lapse data — no indexer, no extra contract bookkeeping.

## Force inclusion

If the server refuses your mutation, you can land it yourself:

```bash
PRIVATE_KEY=0x... X=64 Y=64 COLOR=1 WAIT=1 bun run force-paint
```

That calls `enqueue()` onchain, and after `FORCE_INCLUSION_DELAY` (658 blocks,
≈4.4 minutes at 0.4s) anyone can settle it with `forceExecute()`. In normal
operation the server notices the queued mutation and includes it for you. Unlike
normal play, the caller pays their own gas — which is also why it is not a spam
vector.

## Local dev loop

Three terminals, from `apps/pixel-war`:

```bash
anvil --block-time 0.4
cp .env.example.local .env && bun run deploy   # prints the deployed address
bun dev
```

Open <http://localhost:3000>. The same process serves the API, the frontend, and
the Typewriter runtime. If the deploy address differs from the one in
`.env.example.local`, update `PIXEL_WAR_ADDRESS`.

To make the canvas move on its own:

```bash
BOT_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d bun run bot
```

Run several with different `BOT_KEY`s and `SHAPE=blob|scatter|stripe`.

## Environment

| Variable | Used by | Description |
|---|---|---|
| `PRIVATE_KEY` | `bun dev`, `bun start`, `bun run deploy` | Scheduler key. Pays for every settlement transaction and signs `AdvanceEpoch`. |
| `DATABASE_URL` | backend, tests | Postgres connection string |
| `PIXEL_WAR_ADDRESS` | backend, scripts | Deployed `PixelWar` address |
| `RPC_URL` | backend, scripts, deploy | RPC endpoint; comma-separated for backend failover |
| `CHAIN_ID` | backend, scripts | `31337` for anvil, `10143` for Monad testnet |
| `BUN_PUBLIC_RP_ID` | frontend | WebAuthn relying party ID, usually the hostname |
| `BUN_PUBLIC_ORIGIN` | frontend | Expected WebAuthn origin |
| `API_URL` | scripts | Running backend URL |
| `EPOCH_INTERVAL_MS` | backend | Epoch length, default `10000` |
| `RATE_LIMIT_PER_SECOND`, `RATE_LIMIT_BURST` | backend | Per-IP submission limits, default `25`/`60` |

The scheduler key is the epoch authority: `EPOCH_AUTHORITY` is
`keccak256(abi.encode(scheduler))`, fixed at deploy. Changing the scheduler key
means redeploying. On first boot the server registers that account itself, which
also means it joins a team — one extra player on team 0, which is harmless.

## Deploying publicly

Sponsored gas is a griefing surface: a public deployment spends the server's
money on every mutation. Three things bound it —

1. the contract's per-epoch energy cap (30 actions/epoch/account),
2. per-IP rate limits on `POST /api`,
3. a funded-balance alarm on the scheduler key, which you have to run yourself.

Passkeys are bound to `BUN_PUBLIC_RP_ID`, so pick the production hostname before
players create credentials — moving the domain later orphans every passkey.

## Checks

From `apps/pixel-war`:

```bash
forge test --root contracts
bun test                 # needs Postgres and the typewriter-evm native addon
bun run typecheck
```

`forge test` skips one P-256 test unless it runs under the Monad build of
Foundry: the RIP-7212 precompile at `address(0x100)` does not exist in upstream
Foundry. Browser session keys are P-256, so that path matters — it is covered
against the precompile the runtime actually uses, and the rest of the suite uses
secp256k1.

## Layout

- `contracts/` — `PixelWar.sol`, one library per mutation, deploy script, Foundry tests.
- `src/` — server: runtime config, canvas mirror, read-model queries, HTTP routes.
- `sdk/` — constants, palette, EIP-712 types, canvas math shared by server, frontend, and scripts.
- `frontend/` — React canvas, passkey sign-up, session keys, live activity feed.
- `scripts/` — `bot.ts` (autonomous player) and `force-paint.ts` (force-inclusion demo).
