// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {matchOrder} from "./Book.sol";
import {abs, chargeFee, requireInitialMargin, untrackIfEmpty} from "./Margin.sol";
import {
    InsufficientLiquidity,
    InvalidOrder,
    Market,
    MarketHalted,
    MarketStatus,
    Position,
    ReduceOnly,
    Side,
    State,
    listedMarket
} from "./Perps.sol";

/// Fill-or-kill: fills all of `quantity` at prices no worse than
/// `limitPrice`, or reverts. A fill that grows the position needs initial
/// margin afterwards; one that shrinks it doesn't.
library MarketOrderMutation {
    struct MarketOrder {
        uint64 marketId;
        Side side;
        uint64 quantity;
        uint64 limitPrice;
    }

    function execute(State storage state, MarketOrder memory order, bytes32 accountID) internal {
        Market storage market = listedMarket(state, order.marketId);
        if (market.status == MarketStatus.Halted) revert MarketHalted();
        if (order.quantity == 0) revert InvalidOrder();

        Position storage position = state.accounts[accountID].positions[order.marketId];
        uint256 sizeBefore = abs(position.size);
        (uint64 filled, uint256 notional) =
            matchOrder(state, accountID, order.marketId, order.side, order.quantity, order.limitPrice);
        if (filled < order.quantity) revert InsufficientLiquidity();
        chargeFee(state, accountID, notional, market.takerFeeBps);

        if (abs(position.size) > sizeBefore) {
            if (market.status == MarketStatus.ReduceOnly) revert ReduceOnly();
            requireInitialMargin(state, accountID);
        }
        untrackIfEmpty(state.accounts[accountID], order.marketId);
    }
}
