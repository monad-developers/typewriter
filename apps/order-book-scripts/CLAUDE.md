# CLAUDE.md — order-book-scripts

TS scripts emulating market participants (limit, market, market-maker, retail, arbitrage, gas). Drives the backend's HTTP API.

## Running

From this directory:

```bash
bun scripts/add-instrument.ts                                                   # run first
PRICE=2400 SIDE=buy QUANTITY=1 INSTRUMENT=GOLD/USD bun scripts/limit-order.ts
SIDE=buy QUANTITY=0.5 INSTRUMENT=GOLD/USD bun scripts/market-order.ts
```
