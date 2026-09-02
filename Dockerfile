# syntax=docker/dockerfile:1.7
#
# Monorepo image used by every Railway service in this repo.
# Railway auto-detects the Dockerfile at the repo root and bypasses
# Railpack/Nixpacks. Each Railway service sets its own Custom Start
# Command (overrides CMD), so CMD here is only a harmless default.

ARG BUN_VERSION=1.3.13
ARG FOUNDRY_VERSION=v1.8.1
ARG RUST_VERSION=1.98.0

# ---------------------------------------------------------------------------
# Stage 1: foundry - download and extract the pinned official Foundry toolchain.
# Kept isolated so the final image only copies the four binaries it needs.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS foundry
ARG FOUNDRY_VERSION
ARG TARGETARCH=amd64

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ENV FOUNDRY_DIR=/root/.foundry
ENV PATH=${FOUNDRY_DIR}/bin:${PATH}

RUN case "${TARGETARCH}" in \
        amd64) foundry_sha256=37b45855232e57624d90113b049ca54f0c92055bb5c1997fcbdc3076c7b89c10 ;; \
        arm64) foundry_sha256=27a32bd282d73018ab4d043de15ab0320b561c71b4bf3a549b130a0806e79f5c ;; \
        *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && mkdir -p "${FOUNDRY_DIR}/bin" \
    && curl -fL "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${TARGETARCH}.tar.gz" -o /tmp/foundry.tar.gz \
    && printf '%s  /tmp/foundry.tar.gz\n' "${foundry_sha256}" | sha256sum -c - \
    && tar -xzf /tmp/foundry.tar.gz -C "${FOUNDRY_DIR}/bin" \
    && rm /tmp/foundry.tar.gz \
    && forge --version \
    && anvil --version \
    && cast --version

# ---------------------------------------------------------------------------
# Stage 2: build - install workspace deps, build contracts, build frontend.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-debian AS build
ARG RUST_VERSION

# System deps required by forge build (git for github: deps, libssl/ca-certs
# for TLS), the Rust native addon build, and Next.js builds. Rust stays in this
# build stage; the runtime image receives only the built workspace output.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        git \
        libssl-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:${PATH}

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}" \
    && rustc --version \
    && cargo --version

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

# Workspace build. Fans out to per-package `build` scripts via the root's
# `bun run --filter '*' build` (e.g. `forge build` for contract packages).
RUN bun run build

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
# Each service should wrap shell-form commands in `/bin/sh -c '...'` because
# Railway runs start commands in exec form — `cd app && bun start` fails
# without the wrapper since `cd` is a shell built-in, not a binary.
CMD ["bun", "--version"]
