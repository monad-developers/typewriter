# Typewriter Docs

The documentation website for Typewriter, built with [Vocs](https://vocs.dev)
(v2, Waku-based) and deployed to Vercel at
[typewriter-docs.monadinternal.com](https://typewriter-docs.monadinternal.com)
behind Cloudflare Access.

## A first-class Bun workspace

Unlike a typical standalone docs site, this directory is a **full member of the
Bun monorepo**:

- Listed in the root `package.json` `workspaces`, so `bun install` at the repo
  root installs it and it shares the root `bun.lock`.
- **Typechecked and linted in CI alongside every other workspace** — `bun run
  lint` (Biome, repo-wide) and `bun run typecheck` (its entry is wired into the
  root `typecheck` script) both cover it.
- Built by `bun run build` (`--filter '*'`) like the rest of the workspaces.

Because Waku pulls `react-server-dom-webpack@~19.2.4`, this workspace pins
`react`/`react-dom` at `19.2.8` (the app workspaces pin `19.2.4`); Bun keeps both.

## Local development

```bash
bun install        # from the repo root
cd docs
bun run dev        # local dev server
bun run build      # production build
bun run preview    # preview the production build
```

## Deployment

Vocs 2 is a [Waku](https://waku.gg) (React Server Components) app, not a static
export. On Vercel (`VERCEL=1`), `vocs build` emits a
[Build Output API](https://vercel.com/docs/build-output-api) bundle
(`.vercel/output/` — static assets + a `nodejs22.x` RSC serverless function),
which Vercel deploys directly. It runs as a separate Vercel project
`typewriter-docs` with the repo root as the Vercel Root Directory set to `docs`.

### Access control

`typewriter-docs.monadinternal.com` is gated by Cloudflare Access (MF Google
SSO). Note: because the Vocs 2 app deploys via the Build Output API, it can't
take a drop-in Vercel Edge Middleware the way the static v1 scaffold did, so the
raw `*.vercel.app` bypass is closed with Vercel Deployment Protection rather than
an in-app JWT check.
