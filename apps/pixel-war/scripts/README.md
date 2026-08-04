# Scripts

Run from `apps/pixel-war`, which loads the workspace `.env`.

## `bot.ts` — an autonomous player

Registers its own account and keeps acting, so a demo canvas stays alive and the
throughput numbers have something to count.

```bash
BOT_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d bun run bot
```

| Variable | Default | Description |
|---|---|---|
| `BOT_KEY` | required | Any 32-byte hex private key. The account id is derived from it. |
| `API_URL` | `http://localhost:3000` | Running backend |
| `INTERVAL_MS` | `400` | Delay between actions |
| `SHAPE` | `blob` | `blob` (random walk around a home pixel), `scatter`, `stripe` |
| `BOT_TOOL` | `mix` | `mix` (mostly paint, some shields and bombs), or a single tool |

Rejections are normal play: the bot runs out of energy every epoch and sometimes
tries to shield a pixel its team does not hold.

## `force-paint.ts` — force inclusion

Puts a signed paint onchain directly, bypassing the server. Needs a key funded on
the target chain, because the caller pays this gas themselves.

```bash
PRIVATE_KEY=0x... X=64 Y=64 COLOR=1 WAIT=1 bun run force-paint
```

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | required | Funded key; also derives the acting account id |
| `X`, `Y` | `64` | Target pixel |
| `COLOR` | `1` | Palette index. Must belong to the account's team, or execution reverts |
| `NONCE_LANE`, `NONCE_SEQ` | `7`, `0` | Nonce lane and sequence for the mutation |
| `WAIT` | unset | `1` polls until the force-inclusion delay elapses, then calls `forceExecute` |

Without `WAIT=1` the script stops after `enqueue`. In normal operation the server
notices the queued mutation and settles it well before the delay expires — which
is the interesting half of the demo. Set `WAIT=1` to prove it lands even with the
server stopped.

The account must already exist (sign up in the UI or run the bot once with the
same key), since `Paint` needs a registered key to verify against.
