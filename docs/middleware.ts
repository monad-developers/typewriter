// middleware.ts — Vercel Edge Middleware that enforces Cloudflare Access.
//
// The docs site is a static Vocs build, so it has no server framework of its
// own. Internal MF apps sit behind Cloudflare Access on `*.monadinternal.com`,
// but the raw `*.vercel.app` URL that Vercel assigns bypasses Cloudflare
// entirely. This middleware is the safety net for that host: it verifies the
// Cloudflare Access JWT and, for the production `*.vercel.app` host, redirects
// browsers to the canonical `*.monadinternal.com` URL.
//
// It is inert until `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` are set on the
// Vercel project, so it is safe to ship in the initial scaffold before the
// deploy pipeline wires up Cloudflare Access.
//
// Adapted from monad-exp/ts-project-template's Next.js `proxy.ts` for a
// framework-agnostic (non-Next) static deploy.

import { next } from "@vercel/edge";
import { createRemoteJWKSet, jwtVerify } from "jose";

// No path is excluded: this runs on every request, so nothing can skip the
// Access check by accident.
export const config = {
  matcher: "/:path*",
};

// Bracket access: the docs subproject inherits the repo-root tsconfig, which
// enables `noPropertyAccessFromIndexSignature`, so `process.env` is read by key.
const TEAM_DOMAIN = process.env["CF_ACCESS_TEAM_DOMAIN"];
const AUD = process.env["CF_ACCESS_AUD"];
const JWKS = TEAM_DOMAIN
  ? createRemoteJWKSet(new URL(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`))
  : null;

export default async function middleware(request: Request): Promise<Response> {
  // Not configured yet (no CF Access env vars) — let requests through so the
  // scaffold works before the deploy pipeline wires up Cloudflare Access.
  if (TEAM_DOMAIN === undefined || AUD === undefined || JWKS === null) {
    return next();
  }

  const isPreview = process.env["VERCEL_ENV"] === "preview";

  // Primary check: a valid CF Access JWT proves the request went through
  // Cloudflare Access, regardless of which host it arrived on. This holds even
  // if the preview suffix is removed and a *.vercel.app host appears.
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (jwt !== null) {
    try {
      await jwtVerify(jwt, JWKS, {
        audience: AUD,
        issuer: `https://${TEAM_DOMAIN}`,
      });
      return next();
    } catch (err) {
      console.error("CF Access JWT verification failed:", err);
    }
  }

  // No valid JWT — the request did not come through CF Access.

  // If this is a browser request to the production *.vercel.app URL (which
  // Vercel does not let us remove), redirect to the corresponding
  // *.monadinternal.com URL.
  const wantsHtml =
    request.method === "GET" &&
    (request.headers.get("accept")?.includes("text/html") ?? false);
  const canonicalHost = process.env["VERCEL_PROJECT_PRODUCTION_URL"];
  const url = new URL(request.url);

  if (
    !isPreview &&
    wantsHtml &&
    canonicalHost !== undefined &&
    !canonicalHost.endsWith(".vercel.app") &&
    url.host !== canonicalHost
  ) {
    return Response.redirect(
      `https://${canonicalHost}${url.pathname}${url.search}`,
      307,
    );
  }

  return new Response("Unauthorized", { status: 401 });
}
