# Typewriter Docs

The documentation website for Typewriter, built with [Vocs](https://vocs.dev)
and deployed to Vercel behind Cloudflare Access at
[typewriter-docs.monadinternal.com](https://typewriter-docs.monadinternal.com).

## Isolation from the monorepo

This directory is a **self-contained project**, deliberately kept separate from
the Bun monorepo that surrounds it:

- It is **not** a Bun workspace (not listed in the root `package.json`
  `workspaces`), so `bun install` / `bun run build` / the repo's CI never touch
  it.
- It is **npm-managed** (`package-lock.json`), because Vocs is a Vite-based tool
  in the npm ecosystem and this keeps it clear of the root `bunfig.toml`
  supply-chain guards (`minimumReleaseAge`, `ignoreScripts`).
- It is **excluded from the repo's Biome** (`!docs/**` in `biome.json`) — it has
  its own toolchain.

## Local development

```bash
cd docs
npm install
npm run dev      # local dev server
npm run build    # static build → dist/
npm run preview  # preview the production build
```

## Deployment

Deployed as a **static** site on Vercel (separate Vercel project
`typewriter-docs`, root directory `docs`):

- Build command: `npm run build` (`vocs build`)
- Output directory: `dist`

### Access control

Because a static Vocs site has no server framework, `middleware.ts` is a Vercel
Edge Middleware (ported from the `ts-project-template` Next.js `proxy.ts`) that
verifies the Cloudflare Access JWT. It closes the raw `*.vercel.app` bypass so
the site is only reachable through Cloudflare Access on
`typewriter-docs.monadinternal.com`. It reads `CF_ACCESS_TEAM_DOMAIN` and
`CF_ACCESS_AUD` (see `.env.example`) and is inert until those are set.
