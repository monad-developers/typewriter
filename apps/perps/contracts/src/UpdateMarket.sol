// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Market, MarketStatus, State, listedMarket, requireAdmin, validateRiskParams} from "./Perps.sol";

/// Raising margin requirements applies to open positions immediately, so it
/// can make accounts liquidatable.
library UpdateMarketMutation {
    struct UpdateMarket {
        uint64 marketId;
        MarketStatus status;
        uint16 initialMarginBps;
        uint16 maintenanceMarginBps;
        uint16 takerFeeBps;
        uint16 liquidationFeeBps;
    }

    function execute(State storage state, UpdateMarket memory update, bytes32 accountID) internal {
        requireAdmin(state, accountID);
        Market storage market = listedMarket(state, update.marketId);
        validateRiskParams(
            update.initialMarginBps, update.maintenanceMarginBps, update.takerFeeBps, update.liquidationFeeBps
        );

        market.status = update.status;
        market.initialMarginBps = update.initialMarginBps;
        market.maintenanceMarginBps = update.maintenanceMarginBps;
        market.takerFeeBps = update.takerFeeBps;
        market.liquidationFeeBps = update.liquidationFeeBps;
    }
}
