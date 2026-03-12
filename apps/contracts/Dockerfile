FROM ghcr.io/foundry-rs/foundry:latest AS foundry

FROM oven/bun:1 AS runtime

# Copy foundry binaries
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
COPY --from=foundry /usr/local/bin/cast /usr/local/bin/cast

WORKDIR /app

# Copy root workspace files needed for bun workspaces
COPY package.json bun.lock ./
COPY apps/contracts/package.json ./apps/contracts/

# Install dependencies (workspace-aware)
RUN bun install --frozen-lockfile

# Copy contracts source
COPY apps/contracts/ ./apps/contracts/

WORKDIR /app/apps/contracts

# Build contracts
RUN forge build

CMD ["bun", "run", "start"]
