import { beforeEach, expect, test } from "bun:test";
import type { State } from "./api";
import {
  findRoute,
  MutationType,
  matchLimitOrder,
  matchMarketOrder,
  resolveAndOrderMutations,
} from "./api";
import { EXAMPLE_STATE } from "./constants";

let state: State<bigint>;

beforeEach(() => {
  state = structuredClone(EXAMPLE_STATE);
});

test("market buy walks asks ascending", () => {
  const fills = matchMarketOrder(state.instruments[0]!, {
    id: "1",
    type: MutationType.MarketOrder,
    quantity: 2000000000000000000000n,
    minReceivedQuantity: 0n,
    marketId: 0,
    accountId: 0,
    bidOrAsk: 0,
  });

  expect(fills).toMatchInlineSnapshot(`
    [
      {
        "quantity": 850000000000000000000n,
        "tickId": 1381050,
      },
      {
        "quantity": 700000000000000000000n,
        "tickId": 1381080,
      },
      {
        "quantity": 450000000000000000000n,
        "tickId": 1381100,
      },
    ]
  `);
});

test("market sell walks bids descending", () => {
  const fills = matchMarketOrder(state.instruments[0]!, {
    id: "1",
    type: MutationType.MarketOrder,
    quantity: 1000000000000000000000n,
    minReceivedQuantity: 0n,
    marketId: 0,
    accountId: 0,
    bidOrAsk: 1,
  });

  expect(fills).toMatchInlineSnapshot(`
    [
      {
        "quantity": 750000000000000000000n,
        "tickId": 1380950,
      },
      {
        "quantity": 250000000000000000000n,
        "tickId": 1380920,
      },
    ]
  `);
});

test("market order partial fill when not enough liquidity", () => {
  const instrument = state.instruments[0]!;
  const totalAsks = Object.values(instrument.asks).reduce(
    (sum, t) => sum + t.remainingQuantity,
    0n,
  );
  const fills = matchMarketOrder(instrument, {
    id: "1",
    type: MutationType.MarketOrder,
    quantity: totalAsks + 1000n,
    minReceivedQuantity: 0n,
    marketId: 0,
    accountId: 0,
    bidOrAsk: 0,
  });

  expect(fills).toMatchInlineSnapshot(`
    [
      {
        "quantity": 850000000000000000000n,
        "tickId": 1381050,
      },
      {
        "quantity": 700000000000000000000n,
        "tickId": 1381080,
      },
      {
        "quantity": 1100000000000000000000n,
        "tickId": 1381100,
      },
      {
        "quantity": 600000000000000000000n,
        "tickId": 1381130,
      },
      {
        "quantity": 3200000000000000000000n,
        "tickId": 1381500,
      },
      {
        "quantity": 2800000000000000000000n,
        "tickId": 1381600,
      },
      {
        "quantity": 4500000000000000000000n,
        "tickId": 1381650,
      },
      {
        "quantity": 2000000000000000000000n,
        "tickId": 1381800,
      },
      {
        "quantity": 8500000000000000000000n,
        "tickId": 1382000,
      },
      {
        "quantity": 7000000000000000000000n,
        "tickId": 1382200,
      },
      {
        "quantity": 11000000000000000000000n,
        "tickId": 1382300,
      },
      {
        "quantity": 6000000000000000000000n,
        "tickId": 1382500,
      },
      {
        "quantity": 20000000000000000000000n,
        "tickId": 1383500,
      },
      {
        "quantity": 35000000000000000000000n,
        "tickId": 1384000,
      },
      {
        "quantity": 18000000000000000000000n,
        "tickId": 1384200,
      },
      {
        "quantity": 22000000000000000000000n,
        "tickId": 1384500,
      },
    ]
  `);
});

test("market order fills span multiple ticks", () => {
  const fills = matchMarketOrder(state.instruments[0]!, {
    id: "1",
    type: MutationType.MarketOrder,
    quantity: 3000000000000000000000n,
    minReceivedQuantity: 0n,
    marketId: 0,
    accountId: 0,
    bidOrAsk: 0,
  });

  expect(fills).toMatchInlineSnapshot(`
    [
      {
        "quantity": 850000000000000000000n,
        "tickId": 1381050,
      },
      {
        "quantity": 700000000000000000000n,
        "tickId": 1381080,
      },
      {
        "quantity": 1100000000000000000000n,
        "tickId": 1381100,
      },
      {
        "quantity": 350000000000000000000n,
        "tickId": 1381130,
      },
    ]
  `);
});

test("limit bid only matches asks at or below limit price", () => {
  const fills = matchLimitOrder(state.instruments[0]!, {
    id: "1",
    type: MutationType.LimitOrder,
    quantity: 10000000000000000000000n,
    marketId: 0,
    accountId: 0,
    tickId: 1385,
    bidOrAsk: 0,
  });

  expect(fills).toMatchInlineSnapshot(`[]`);
});

test("limit bid below best ask gets no fills", () => {
  const fills = matchLimitOrder(state.instruments[0]!, {
    id: "1",
    type: MutationType.LimitOrder,
    quantity: 1000000000000000000000n,
    marketId: 0,
    accountId: 0,
    tickId: 1380,
    bidOrAsk: 0,
  });

  expect(fills).toMatchInlineSnapshot(`[]`);
});

test("limit ask only matches bids at or above limit price", () => {
  const fills = matchLimitOrder(state.instruments[0]!, {
    id: "1",
    type: MutationType.LimitOrder,
    quantity: 10000000000000000000000n,
    marketId: 0,
    accountId: 0,
    tickId: 1370,
    bidOrAsk: 1,
  });

  expect(fills).toMatchInlineSnapshot(`
    [
      {
        "quantity": 750000000000000000000n,
        "tickId": 1380950,
      },
      {
        "quantity": 600000000000000000000n,
        "tickId": 1380920,
      },
      {
        "quantity": 1200000000000000000000n,
        "tickId": 1380900,
      },
      {
        "quantity": 500000000000000000000n,
        "tickId": 1380870,
      },
      {
        "quantity": 2800000000000000000000n,
        "tickId": 1380500,
      },
      {
        "quantity": 2500000000000000000000n,
        "tickId": 1380400,
      },
      {
        "quantity": 1650000000000000000000n,
        "tickId": 1380350,
      },
    ]
  `);
});

test("findRoute returns direct pair", () => {
  expect(findRoute(state, 0, 1)).toMatchInlineSnapshot(`
    [
      {
        "flip": false,
        "instrumentId": 0,
      },
    ]
  `);
});

test("findRoute returns flipped direct pair", () => {
  expect(findRoute(state, 1, 0)).toMatchInlineSnapshot(`
    [
      {
        "flip": true,
        "instrumentId": 0,
      },
    ]
  `);
});

test("findRoute finds intermediate route through USD", () => {
  expect(findRoute(state, 0, 2)).toMatchInlineSnapshot(`
    [
      {
        "flip": false,
        "instrumentId": 0,
      },
      {
        "flip": false,
        "instrumentId": 1,
      },
    ]
  `);
});

test("findRoute throws when no route exists", () => {
  const smallState = structuredClone(state);
  smallState.instruments = [];
  expect(() => findRoute(smallState, 0, 1)).toThrow("No route");
});

test("resolve AddAccount creates account", () => {
  const result = resolveAndOrderMutations(state, [
    {
      id: "1",
      type: MutationType.AddAccount,
      addr: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  ]);

  expect(result).toMatchInlineSnapshot(`
    [
      {
        "addr": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "id": "1",
        "type": 3,
      },
    ]
  `);
  expect(state.accounts.length).toBe(EXAMPLE_STATE.accounts.length + 1);
});

test("resolve AddAsset adds asset", () => {
  const result = resolveAndOrderMutations(state, [
    {
      id: "1",
      type: MutationType.AddAsset,
      asset: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  ]);

  expect(result).toMatchInlineSnapshot(`
    [
      {
        "asset": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "id": "1",
        "type": 5,
      },
    ]
  `);
  expect(state.assets.length).toBe(EXAMPLE_STATE.assets.length + 1);
});

test("resolve AddInstrument adds instrument", () => {
  const result = resolveAndOrderMutations(state, [
    {
      id: "1",
      type: MutationType.AddInstrument,
      baseId: 0,
      quoteId: 2,
    },
  ]);

  expect(result).toMatchInlineSnapshot(`
    [
      {
        "baseId": 0,
        "id": "1",
        "quoteId": 2,
        "type": 4,
      },
    ]
  `);
  expect(state.instruments.length).toBe(EXAMPLE_STATE.instruments.length + 1);
});

test("resolve market buy fills and reduces ask liquidity", () => {
  const result = resolveAndOrderMutations(state, [
    {
      id: "1",
      type: MutationType.MarketOrder,
      quantity: 1000000000000000000000n,
      minReceivedQuantity: 0n,
      marketId: 0,
      accountId: 0,
      bidOrAsk: 0,
    },
  ]);

  expect(result).toMatchInlineSnapshot(`
    [
      [
        {
          "accountId": 0,
          "bidOrAsk": 0,
          "id": "1",
          "marketId": 0,
          "minReceivedQuantity": 0n,
          "quantity": 1000000000000000000000n,
          "type": 0,
        },
        {
          "fills": [
            {
              "quantity": 850000000000000000000n,
              "tickId": 1381050,
            },
            {
              "quantity": 150000000000000000000n,
              "tickId": 1381080,
            },
          ],
          "id": "1",
        },
      ],
    ]
  `);
  expect(state.instruments[0]!.asks).toMatchInlineSnapshot(`
    {
      "1381080": {
        "quantity": 700000000000000000000n,
        "remainingQuantity": 550000000000000000000n,
        "volume": 2,
      },
      "1381100": {
        "quantity": 1100000000000000000000n,
        "remainingQuantity": 1100000000000000000000n,
        "volume": 3,
      },
      "1381130": {
        "quantity": 600000000000000000000n,
        "remainingQuantity": 600000000000000000000n,
        "volume": 1,
      },
      "1381500": {
        "quantity": 3500000000000000000000n,
        "remainingQuantity": 3200000000000000000000n,
        "volume": 4,
      },
      "1381600": {
        "quantity": 2800000000000000000000n,
        "remainingQuantity": 2800000000000000000000n,
        "volume": 3,
      },
      "1381650": {
        "quantity": 4500000000000000000000n,
        "remainingQuantity": 4500000000000000000000n,
        "volume": 5,
      },
      "1381800": {
        "quantity": 2000000000000000000000n,
        "remainingQuantity": 2000000000000000000000n,
        "volume": 2,
      },
      "1382000": {
        "quantity": 9000000000000000000000n,
        "remainingQuantity": 8500000000000000000000n,
        "volume": 6,
      },
      "1382200": {
        "quantity": 7000000000000000000000n,
        "remainingQuantity": 7000000000000000000000n,
        "volume": 5,
      },
      "1382300": {
        "quantity": 11000000000000000000000n,
        "remainingQuantity": 11000000000000000000000n,
        "volume": 7,
      },
      "1382500": {
        "quantity": 6000000000000000000000n,
        "remainingQuantity": 6000000000000000000000n,
        "volume": 4,
      },
      "1383500": {
        "quantity": 20000000000000000000000n,
        "remainingQuantity": 20000000000000000000000n,
        "volume": 9,
      },
      "1384000": {
        "quantity": 35000000000000000000000n,
        "remainingQuantity": 35000000000000000000000n,
        "volume": 11,
      },
      "1384200": {
        "quantity": 18000000000000000000000n,
        "remainingQuantity": 18000000000000000000000n,
        "volume": 7,
      },
      "1384500": {
        "quantity": 22000000000000000000000n,
        "remainingQuantity": 22000000000000000000000n,
        "volume": 6,
      },
    }
  `);
  expect(state.accounts[0]!.balances).toMatchInlineSnapshot(`
    {
      "0": 51000000000000000000000n,
      "1": -1381046500000000000000000000n,
      "2": 200000000000000000000000n,
      "3": 100000000000000000000000n,
      "4": 1500000000000000000000000n,
    }
  `);
});

test("resolve market sell fills and reduces bid liquidity", () => {
  const result = resolveAndOrderMutations(state, [
    {
      id: "1",
      type: MutationType.MarketOrder,
      quantity: 1000000000000000000000n,
      minReceivedQuantity: 0n,
      marketId: 0,
      accountId: 0,
      bidOrAsk: 1,
    },
  ]);

  expect(result).toMatchInlineSnapshot(`
    [
      [
        {
          "accountId": 0,
          "bidOrAsk": 1,
          "id": "1",
          "marketId": 0,
          "minReceivedQuantity": 0n,
          "quantity": 1000000000000000000000n,
          "type": 0,
        },
        {
          "fills": [
            {
              "quantity": 750000000000000000000n,
              "tickId": 1380950,
            },
            {
              "quantity": 250000000000000000000n,
              "tickId": 1380920,
            },
          ],
          "id": "1",
        },
      ],
    ]
  `);
  expect(state.instruments[0]!.bids).toMatchInlineSnapshot(`
    {
      "1377500": {
        "quantity": 20000000000000000000000n,
        "remainingQuantity": 20000000000000000000000n,
        "volume": 5,
      },
      "1377800": {
        "quantity": 15000000000000000000000n,
        "remainingQuantity": 15000000000000000000000n,
        "volume": 6,
      },
      "1378000": {
        "quantity": 30000000000000000000000n,
        "remainingQuantity": 30000000000000000000000n,
        "volume": 10,
      },
      "1378500": {
        "quantity": 25000000000000000000000n,
        "remainingQuantity": 25000000000000000000000n,
        "volume": 8,
      },
      "1379500": {
        "quantity": 5000000000000000000000n,
        "remainingQuantity": 5000000000000000000000n,
        "volume": 3,
      },
      "1379700": {
        "quantity": 10000000000000000000000n,
        "remainingQuantity": 10000000000000000000000n,
        "volume": 7,
      },
      "1379800": {
        "quantity": 6000000000000000000000n,
        "remainingQuantity": 6000000000000000000000n,
        "volume": 4,
      },
      "1380000": {
        "quantity": 8000000000000000000000n,
        "remainingQuantity": 7500000000000000000000n,
        "volume": 6,
      },
      "1380200": {
        "quantity": 1800000000000000000000n,
        "remainingQuantity": 1800000000000000000000n,
        "volume": 2,
      },
      "1380350": {
        "quantity": 4000000000000000000000n,
        "remainingQuantity": 4000000000000000000000n,
        "volume": 5,
      },
      "1380400": {
        "quantity": 2500000000000000000000n,
        "remainingQuantity": 2500000000000000000000n,
        "volume": 3,
      },
      "1380500": {
        "quantity": 3000000000000000000000n,
        "remainingQuantity": 2800000000000000000000n,
        "volume": 4,
      },
      "1380870": {
        "quantity": 500000000000000000000n,
        "remainingQuantity": 500000000000000000000n,
        "volume": 1,
      },
      "1380900": {
        "quantity": 1200000000000000000000n,
        "remainingQuantity": 1200000000000000000000n,
        "volume": 2,
      },
      "1380920": {
        "quantity": 600000000000000000000n,
        "remainingQuantity": 350000000000000000000n,
        "volume": 2,
      },
    }
  `);
  expect(state.accounts[0]!.balances).toMatchInlineSnapshot(`
    {
      "0": 49000000000000000000000n,
      "1": 1380950500000000000000000000n,
      "2": 200000000000000000000000n,
      "3": 100000000000000000000000n,
      "4": 1500000000000000000000000n,
    }
  `);
});

test("resolve crossing limit bid gets fills and updates book", () => {
  const result = resolveAndOrderMutations(state, [
    {
      id: "1",
      type: MutationType.LimitOrder,
      quantity: 2000000000000000000000n,
      marketId: 0,
      accountId: 0,
      tickId: 1390,
      bidOrAsk: 0,
    },
  ]);

  expect(result).toMatchInlineSnapshot(`
    [
      [
        {
          "accountId": 0,
          "bidOrAsk": 0,
          "id": "1",
          "marketId": 0,
          "quantity": 2000000000000000000000n,
          "tickId": 1390,
          "type": 1,
        },
        {
          "fills": [],
          "id": "1",
        },
      ],
    ]
  `);
  expect(state.instruments[0]!.asks).toMatchInlineSnapshot(`
    {
      "1381050": {
        "quantity": 900000000000000000000n,
        "remainingQuantity": 850000000000000000000n,
        "volume": 2,
      },
      "1381080": {
        "quantity": 700000000000000000000n,
        "remainingQuantity": 700000000000000000000n,
        "volume": 2,
      },
      "1381100": {
        "quantity": 1100000000000000000000n,
        "remainingQuantity": 1100000000000000000000n,
        "volume": 3,
      },
      "1381130": {
        "quantity": 600000000000000000000n,
        "remainingQuantity": 600000000000000000000n,
        "volume": 1,
      },
      "1381500": {
        "quantity": 3500000000000000000000n,
        "remainingQuantity": 3200000000000000000000n,
        "volume": 4,
      },
      "1381600": {
        "quantity": 2800000000000000000000n,
        "remainingQuantity": 2800000000000000000000n,
        "volume": 3,
      },
      "1381650": {
        "quantity": 4500000000000000000000n,
        "remainingQuantity": 4500000000000000000000n,
        "volume": 5,
      },
      "1381800": {
        "quantity": 2000000000000000000000n,
        "remainingQuantity": 2000000000000000000000n,
        "volume": 2,
      },
      "1382000": {
        "quantity": 9000000000000000000000n,
        "remainingQuantity": 8500000000000000000000n,
        "volume": 6,
      },
      "1382200": {
        "quantity": 7000000000000000000000n,
        "remainingQuantity": 7000000000000000000000n,
        "volume": 5,
      },
      "1382300": {
        "quantity": 11000000000000000000000n,
        "remainingQuantity": 11000000000000000000000n,
        "volume": 7,
      },
      "1382500": {
        "quantity": 6000000000000000000000n,
        "remainingQuantity": 6000000000000000000000n,
        "volume": 4,
      },
      "1383500": {
        "quantity": 20000000000000000000000n,
        "remainingQuantity": 20000000000000000000000n,
        "volume": 9,
      },
      "1384000": {
        "quantity": 35000000000000000000000n,
        "remainingQuantity": 35000000000000000000000n,
        "volume": 11,
      },
      "1384200": {
        "quantity": 18000000000000000000000n,
        "remainingQuantity": 18000000000000000000000n,
        "volume": 7,
      },
      "1384500": {
        "quantity": 22000000000000000000000n,
        "remainingQuantity": 22000000000000000000000n,
        "volume": 6,
      },
    }
  `);
  expect(state.accounts[0]!.balances).toMatchInlineSnapshot(`
    {
      "0": 50000000000000000000000n,
      "1": -2772000000000000000000000n,
      "2": 200000000000000000000000n,
      "3": 100000000000000000000000n,
      "4": 1500000000000000000000000n,
    }
  `);
});

test("resolve non-crossing limit bid rests on book with no fills", () => {
  const result = resolveAndOrderMutations(state, [
    {
      id: "1",
      type: MutationType.LimitOrder,
      quantity: 1000000000000000000000n,
      marketId: 0,
      accountId: 0,
      tickId: 1380,
      bidOrAsk: 0,
    },
  ]);

  expect(result).toMatchInlineSnapshot(`
    [
      [
        {
          "accountId": 0,
          "bidOrAsk": 0,
          "id": "1",
          "marketId": 0,
          "quantity": 1000000000000000000000n,
          "tickId": 1380,
          "type": 1,
        },
        {
          "fills": [],
          "id": "1",
        },
      ],
    ]
  `);
  expect(state.instruments[0]!.bids).toMatchInlineSnapshot(`
    {
      "1377500": {
        "quantity": 20000000000000000000000n,
        "remainingQuantity": 20000000000000000000000n,
        "volume": 5,
      },
      "1377800": {
        "quantity": 15000000000000000000000n,
        "remainingQuantity": 15000000000000000000000n,
        "volume": 6,
      },
      "1378000": {
        "quantity": 30000000000000000000000n,
        "remainingQuantity": 30000000000000000000000n,
        "volume": 10,
      },
      "1378500": {
        "quantity": 25000000000000000000000n,
        "remainingQuantity": 25000000000000000000000n,
        "volume": 8,
      },
      "1379500": {
        "quantity": 5000000000000000000000n,
        "remainingQuantity": 5000000000000000000000n,
        "volume": 3,
      },
      "1379700": {
        "quantity": 10000000000000000000000n,
        "remainingQuantity": 10000000000000000000000n,
        "volume": 7,
      },
      "1379800": {
        "quantity": 6000000000000000000000n,
        "remainingQuantity": 6000000000000000000000n,
        "volume": 4,
      },
      "1380": {
        "quantity": 1000000000000000000000n,
        "remainingQuantity": 1000000000000000000000n,
        "volume": 1,
      },
      "1380000": {
        "quantity": 8000000000000000000000n,
        "remainingQuantity": 7500000000000000000000n,
        "volume": 6,
      },
      "1380200": {
        "quantity": 1800000000000000000000n,
        "remainingQuantity": 1800000000000000000000n,
        "volume": 2,
      },
      "1380350": {
        "quantity": 4000000000000000000000n,
        "remainingQuantity": 4000000000000000000000n,
        "volume": 5,
      },
      "1380400": {
        "quantity": 2500000000000000000000n,
        "remainingQuantity": 2500000000000000000000n,
        "volume": 3,
      },
      "1380500": {
        "quantity": 3000000000000000000000n,
        "remainingQuantity": 2800000000000000000000n,
        "volume": 4,
      },
      "1380870": {
        "quantity": 500000000000000000000n,
        "remainingQuantity": 500000000000000000000n,
        "volume": 1,
      },
      "1380900": {
        "quantity": 1200000000000000000000n,
        "remainingQuantity": 1200000000000000000000n,
        "volume": 2,
      },
      "1380920": {
        "quantity": 600000000000000000000n,
        "remainingQuantity": 600000000000000000000n,
        "volume": 2,
      },
      "1380950": {
        "quantity": 800000000000000000000n,
        "remainingQuantity": 750000000000000000000n,
        "volume": 3,
      },
    }
  `);
  expect(state.accounts[0]!.balances).toMatchInlineSnapshot(`
    {
      "0": 50000000000000000000000n,
      "1": -1372000000000000000000000n,
      "2": 200000000000000000000000n,
      "3": 100000000000000000000000n,
      "4": 1500000000000000000000000n,
    }
  `);
});

test("resolve close order zeroes quantity and returns unfilled balance", () => {
  resolveAndOrderMutations(state, [
    {
      id: "1",
      type: MutationType.CloseOrder,
      accountId: 0,
      orderId: 0,
    },
  ]);

  expect(state.accounts[0]!).toMatchInlineSnapshot(`
    {
      "balances": {
        "0": 50000000000000000000000n,
        "1": 1294648625000000000000000000n,
        "2": 200000000000000000000000n,
        "3": 100000000000000000000000n,
        "4": 1500000000000000000000000n,
      },
      "nonce": 5,
      "orders": [
        {
          "marketId": 0,
          "quantity": 0n,
          "side": 0,
          "tickId": 1380950,
          "tickVolume": 3,
        },
        {
          "marketId": 1,
          "quantity": 5000000000000000000000n,
          "side": 1,
          "tickId": 119770,
          "tickVolume": 1,
        },
        {
          "marketId": 3,
          "quantity": 2000000000000000000000n,
          "side": 0,
          "tickId": 66228,
          "tickVolume": 2,
        },
      ],
    }
  `);
  expect(state.instruments[0]!.bids).toMatchInlineSnapshot(`
    {
      "1377500": {
        "quantity": 20000000000000000000000n,
        "remainingQuantity": 20000000000000000000000n,
        "volume": 5,
      },
      "1377800": {
        "quantity": 15000000000000000000000n,
        "remainingQuantity": 15000000000000000000000n,
        "volume": 6,
      },
      "1378000": {
        "quantity": 30000000000000000000000n,
        "remainingQuantity": 30000000000000000000000n,
        "volume": 10,
      },
      "1378500": {
        "quantity": 25000000000000000000000n,
        "remainingQuantity": 25000000000000000000000n,
        "volume": 8,
      },
      "1379500": {
        "quantity": 5000000000000000000000n,
        "remainingQuantity": 5000000000000000000000n,
        "volume": 3,
      },
      "1379700": {
        "quantity": 10000000000000000000000n,
        "remainingQuantity": 10000000000000000000000n,
        "volume": 7,
      },
      "1379800": {
        "quantity": 6000000000000000000000n,
        "remainingQuantity": 6000000000000000000000n,
        "volume": 4,
      },
      "1380000": {
        "quantity": 8000000000000000000000n,
        "remainingQuantity": 7500000000000000000000n,
        "volume": 6,
      },
      "1380200": {
        "quantity": 1800000000000000000000n,
        "remainingQuantity": 1800000000000000000000n,
        "volume": 2,
      },
      "1380350": {
        "quantity": 4000000000000000000000n,
        "remainingQuantity": 4000000000000000000000n,
        "volume": 5,
      },
      "1380400": {
        "quantity": 2500000000000000000000n,
        "remainingQuantity": 2500000000000000000000n,
        "volume": 3,
      },
      "1380500": {
        "quantity": 3000000000000000000000n,
        "remainingQuantity": 2800000000000000000000n,
        "volume": 4,
      },
      "1380870": {
        "quantity": 500000000000000000000n,
        "remainingQuantity": 500000000000000000000n,
        "volume": 1,
      },
      "1380900": {
        "quantity": 1200000000000000000000n,
        "remainingQuantity": 1200000000000000000000n,
        "volume": 2,
      },
      "1380920": {
        "quantity": 600000000000000000000n,
        "remainingQuantity": 600000000000000000000n,
        "volume": 2,
      },
      "1380950": {
        "quantity": -200000000000000000000n,
        "remainingQuantity": -187500000000000000000n,
        "volume": 3,
      },
    }
  `);
});

test("mixed batch orders admins first, then closes, then orders", () => {
  const result = resolveAndOrderMutations(state, [
    {
      id: "market",
      type: MutationType.MarketOrder,
      quantity: 100000000000000000000n,
      minReceivedQuantity: 0n,
      marketId: 0,
      accountId: 0,
      bidOrAsk: 0,
    },
    {
      id: "account",
      type: MutationType.AddAccount,
      addr: "0xcccccccccccccccccccccccccccccccccccccccc",
    },
    {
      id: "close",
      type: MutationType.CloseOrder,
      accountId: 0,
      orderId: 0,
    },
  ]);

  expect(result).toMatchInlineSnapshot(`
    [
      {
        "addr": "0xcccccccccccccccccccccccccccccccccccccccc",
        "id": "account",
        "type": 3,
      },
      {
        "accountId": 0,
        "id": "close",
        "orderId": 0,
        "type": 2,
      },
      [
        {
          "accountId": 0,
          "bidOrAsk": 0,
          "id": "market",
          "marketId": 0,
          "minReceivedQuantity": 0n,
          "quantity": 100000000000000000000n,
          "type": 0,
        },
        {
          "fills": [
            {
              "quantity": 100000000000000000000n,
              "tickId": 1381050,
            },
          ],
          "id": "market",
        },
      ],
    ]
  `);
  expect(state.accounts).toMatchInlineSnapshot(`
    [
      {
        "balances": {
          "0": 50100000000000000000000n,
          "1": 1156543625000000000000000000n,
          "2": 200000000000000000000000n,
          "3": 100000000000000000000000n,
          "4": 1500000000000000000000000n,
        },
        "nonce": 5,
        "orders": [
          {
            "marketId": 0,
            "quantity": 0n,
            "side": 0,
            "tickId": 1380950,
            "tickVolume": 3,
          },
          {
            "marketId": 1,
            "quantity": 5000000000000000000000n,
            "side": 1,
            "tickId": 119770,
            "tickVolume": 1,
          },
          {
            "marketId": 3,
            "quantity": 2000000000000000000000n,
            "side": 0,
            "tickId": 66228,
            "tickVolume": 2,
          },
        ],
      },
      {
        "balances": {
          "0": 120000000000000000000000n,
          "1": 3000000000000000000000n,
          "2": 0n,
          "3": 500000000000000000000000n,
          "4": 800000000000000000000000n,
        },
        "nonce": 3,
        "orders": [
          {
            "marketId": 0,
            "quantity": 2000000000000000000000n,
            "side": 1,
            "tickId": 1381050,
            "tickVolume": 2,
          },
          {
            "marketId": 2,
            "quantity": 8000000000000000000000n,
            "side": 1,
            "tickId": 108705,
            "tickVolume": 1,
          },
        ],
      },
      {
        "balances": {
          "0": 0n,
          "1": 15000000000000000000000n,
          "2": 1000000000000000000000000n,
          "3": 0n,
          "4": 0n,
        },
        "nonce": 1,
        "orders": [],
      },
      {
        "balances": {
          "0": 75000000000000000000000n,
          "1": 22000000000000000000000n,
          "2": 450000000000000000000000n,
          "3": 300000000000000000000000n,
          "4": 2000000000000000000000000n,
        },
        "nonce": 2,
        "orders": [
          {
            "marketId": 0,
            "quantity": 3000000000000000000000n,
            "side": 0,
            "tickId": 1380870,
            "tickVolume": 1,
          },
          {
            "marketId": 1,
            "quantity": 10000000000000000000000n,
            "side": 0,
            "tickId": 119754,
            "tickVolume": 2,
          },
          {
            "marketId": 3,
            "quantity": 50000000000000000000000n,
            "side": 0,
            "tickId": 66195,
            "tickVolume": 3,
          },
        ],
      },
      {
        "balances": {
          "0": 30000000000000000000000n,
          "1": 5500000000000000000000n,
          "2": 80000000000000000000000n,
          "3": 900000000000000000000000n,
          "4": 600000000000000000000000n,
        },
        "nonce": 4,
        "orders": [
          {
            "marketId": 2,
            "quantity": 15000000000000000000000n,
            "side": 0,
            "tickId": 108695,
            "tickVolume": 4,
          },
          {
            "marketId": 3,
            "quantity": 4000000000000000000000n,
            "side": 1,
            "tickId": 66231,
            "tickVolume": 1,
          },
        ],
      },
      {
        "balances": {},
        "nonce": 0,
        "orders": [],
      },
    ]
  `);
});
