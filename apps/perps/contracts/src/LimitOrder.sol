// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {bestPrice, isBetter, opposite, restOrder} from "./Book.sol";
import {requireInitialMargin, worstCaseSize} from "./Margin.sol";
import {
    InvalidOrder,
    Market,
    MarketHalted,
    MarketStatus,
    Position,
    ReduceOnly,
    Side,
    State,
    WouldCross,
    listedMarket
} from "./Perps.sol";

/// A post-only order: it rests on the book, and reverts if it would cross.
/// Take liquidity with `MarketOrder`.
library LimitOrderMutation {
    struct LimitOrder {
        uint64 marketId;
        Side side;
        uint64 price;
        uint64 quantity;
    }

    function execute(State storage state, LimitOrder memory order, bytes32 accountID) internal {
        Market storage market = listedMarket(state, order.marketId);
        if (market.status == MarketStatus.Halted) revert MarketHalted();
        if (order.quantity == 0 || order.price == 0 || order.price % market.tickSize != 0) revert InvalidOrder();

        uint64 best = bestPrice(market, opposite(order.side));
        if (best != 0 && !isBetter(order.side, best, order.price)) revert WouldCross();

        Position storage position = state.accounts[accountID].positions[order.marketId];
        uint256 worstBefore = worstCaseSize(position);
        restOrder(state, accountID, order.marketId, order.side, order.price, order.quantity);
        if (worstCaseSize(position) > worstBefore) {
            if (market.status == MarketStatus.ReduceOnly) revert ReduceOnly();
            requireInitialMargin(state, accountID);
        }
    }
}
