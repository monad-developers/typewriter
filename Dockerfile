# syntax=docker/dockerfile:1.7
#
# Monorepo image used by every Railway service in this repo.
# Railway auto-detects the Dockerfile at the repo root and bypasses
# Railpack/Nixpacks. Each Railway service sets its own Custom Start
# Command (overrides CMD), so CMD here is only a harmless default.

ARG BUN_VERSION=1.3.13
ARG FOUNDRY_VERSION=nightly-c81fa47fb6da28db8d7a0bf2d4fce861b1f22ed0

# ---------------------------------------------------------------------------
# Stage 1: foundry - download and extract the pinned Foundry nightly toolchain.
# Kept isolated so the final image only copies the four binaries it needs.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS foundry
ARG FOUNDRY_VERSION
ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

ENV FOUNDRY_DIR=/root/.foundry
ENV PATH=${FOUNDRY_DIR}/bin:${PATH}

RUN curl -L https://foundry.paradigm.xyz | bash \
    && foundryup --install "${FOUNDRY_VERSION}" \
    && forge --version \
    && anvil --version \
    && cast --version

# ---------------------------------------------------------------------------
# Stage 2: build - install workspace deps, build contracts, build frontend.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-debian AS build

# System deps required by forge build (git for github: deps, libssl/ca-certs
# for TLS) and by Next.js builds. Kept minimal because oven/bun:*-debian
# already ships a usable base.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Bring in the Foundry binaries from stage 1.
COPY --from=foundry /root/.foundry/bin/forge /usr/local/bin/forge
COPY --from=foundry /root/.foundry/bin/cast  /usr/local/bin/cast
COPY --from=foundry /root/.foundry/bin/anvil /usr/local/bin/anvil
COPY --from=foundry /root/.foundry/bin/chisel /usr/local/bin/chisel

WORKDIR /app

# Copy the whole workspace. Workspace installs in Bun resolve against the
# actual package.json files on disk (workspace:* links), so we copy the
# full tree rather than trying to split manifests out.
COPY . .

# Workspace install. --frozen-lockfile ensures reproducibility from bun.lock.
RUN bun install --frozen-lockfile

# Build Foundry contracts. Both order-book-contracts and the older contracts
# dir still carry a foundry.toml, so build both to keep either usable at runtime.
RUN cd apps/order-book-contracts && forge build
RUN cd apps/contracts && forge build

# Next.js production build for the frontend.
RUN cd apps/order-book-frontend && bun run build

# ---------------------------------------------------------------------------
# Stage 3: runtime - final image Railway ships for every service.
# Contains Bun + Foundry binaries + full workspace (source, node_modules,
# forge out/, .next/). Each Railway service selects its entry point via
# its own Custom Start Command.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-debian AS runtime

# Runtime system deps: TLS roots, git (forge script sometimes shells out),
# tini as a small init for clean signal handling in containers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        libssl3 \
        tini \
    && rm -rf /var/lib/apt/lists/*

# Foundry binaries on PATH.
COPY --from=foundry /root/.foundry/bin/forge /usr/local/bin/forge
COPY --from=foundry /root/.foundry/bin/cast  /usr/local/bin/cast
COPY --from=foundry /root/.foundry/bin/anvil /usr/local/bin/anvil
COPY --from=foundry /root/.foundry/bin/chisel /usr/local/bin/chisel

WORKDIR /app

# Bring the fully-built workspace across from the build stage.
COPY --from=build /app /app

ENV NODE_ENV=production \
    PATH=/usr/local/bin:${PATH}

ENTRYPOINT ["/usr/bin/tini", "--"]

# Harmless default. Railway per-service Custom Start Commands override this.
# Examples (set in the Railway dashboard per service):
#   backend:  bun run --cwd apps/order-book-backend start
#   frontend: bun run --cwd apps/order-book-frontend start
#   scripts:  bun apps/order-book-scripts/scripts/loop-retail.ts
CMD ["bun", "--version"]
