# frontend

React + Tailwind frontend for the tx-lifecycle-demo-app, served via [Bun](https://bun.sh).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BUN_PUBLIC_RPC_URL` | `http://localhost:8545` | JSON-RPC URL the app connects to |

Configure in `.env` or pass inline. Bun loads `.env` automatically.

## Usage

Install dependencies:

```bash
bun install
```

Start a development server (with HMR):

```bash
bun dev
```

Run for production:

```bash
bun start
```

Build:

```bash
bun run build
```

Type-check:

```bash
bun run typecheck
```
