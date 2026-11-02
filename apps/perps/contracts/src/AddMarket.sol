// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {InvalidPrice, Market, MarketExists, State, requireAdmin, validateRiskParams} from "./Perps.sol";

library AddMarketMutation {
    struct AddMarket {
        uint64 marketId;
        uint64 tickSize;
        uint64 oraclePrice;
        uint16 initialMarginBps;
        uint16 maintenanceMarginBps;
        uint16 takerFeeBps;
        uint16 liquidationFeeBps;
    }

    function execute(State storage state, AddMarket memory addMarket, bytes32 accountID) internal {
        requireAdmin(state, accountID);
        Market storage market = state.markets[addMarket.marketId];
        if (market.listed) revert MarketExists();
        if (addMarket.tickSize == 0 || addMarket.oraclePrice == 0) revert InvalidPrice();
        validateRiskParams(
            addMarket.initialMarginBps,
            addMarket.maintenanceMarginBps,
            addMarket.takerFeeBps,
            addMarket.liquidationFeeBps
        );

        market.listed = true;
        market.tickSize = addMarket.tickSize;
        market.oraclePrice = addMarket.oraclePrice;
        market.initialMarginBps = addMarket.initialMarginBps;
        market.maintenanceMarginBps = addMarket.maintenanceMarginBps;
        market.takerFeeBps = addMarket.takerFeeBps;
        market.liquidationFeeBps = addMarket.liquidationFeeBps;
        state.marketIds.push(addMarket.marketId);
    }
}
