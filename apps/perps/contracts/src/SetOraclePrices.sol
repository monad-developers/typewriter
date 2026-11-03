// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {InvalidPrice, State, listedMarket, requireAdmin} from "./Perps.sol";

library SetOraclePricesMutation {
    struct OraclePrice {
        uint64 marketId;
        uint64 price;
    }

    struct SetOraclePrices {
        OraclePrice[] prices;
    }

    function execute(State storage state, SetOraclePrices memory update, bytes32 accountID) internal {
        requireAdmin(state, accountID);
        for (uint256 i; i < update.prices.length; i++) {
            OraclePrice memory oraclePrice = update.prices[i];
            if (oraclePrice.price == 0) revert InvalidPrice();
            listedMarket(state, oraclePrice.marketId).oraclePrice = oraclePrice.price;
        }
    }
}
