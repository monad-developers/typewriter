# Typewriter Docs

The documentation website for Typewriter, built with [Vocs](https://vocs.dev) 2
and deployed to
[typewriter-docs.monadinternal.com](https://typewriter-docs.monadinternal.com).

It is a full member of the Bun monorepo; see the "Website" section of the
repo-root `AGENTS.md` for how it fits in and why its `react` pin differs from
the app workspaces.

## Local development

```bash
bun install        # from the repo root
cd docs
bun run dev        # local dev server
```

## Deployment

Vocs 2 is a [Waku](https://waku.gg) (React Server Components) app, not a static
export. On Vercel (`VERCEL=1`), `vocs build` emits a
[Build Output API](https://vercel.com/docs/build-output-api) bundle
(`.vercel/output/` — static assets plus a `nodejs22.x` RSC serverless function)
that Vercel deploys directly. It is its own Vercel project, `typewriter-docs`,
with the Root Directory set to `docs`.

### Access control

The domain is gated by Cloudflare Access (MF Google SSO). Because the app ships
through the Build Output API it can't take a drop-in Vercel Edge Middleware the
way the static v1 scaffold did, so the raw `*.vercel.app` bypass is closed with
Vercel Deployment Protection rather than an in-app JWT check.
