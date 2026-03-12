FROM ghcr.io/foundry-rs/foundry:latest

EXPOSE 8545

ENTRYPOINT ["anvil", "--host", "0.0.0.0", "--block-time", "0.4"]