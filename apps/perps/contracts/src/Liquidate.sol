// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {matchOrder, removeOrder} from "./Book.sol";
import {abs, chargeFee, health, untrackIfEmpty} from "./Margin.sol";
import {
    Account,
    InsufficientLiquidity,
    Market,
    NoPosition,
    NotLiquidatable,
    Position,
    Side,
    State,
    listedMarket,
    requireAdmin
} from "./Perps.sol";

/// Closes up to `quantity` lots of an account below maintenance margin
/// against the book, at prices no worse than `limitPrice`, after cancelling
/// all its resting orders. The account pays the liquidation fee to the
/// insurance fund, which absorbs any debt left once it has no positions.
library LiquidateMutation {
    struct Liquidate {
        bytes32 account;
        uint64 marketId;
        uint64 quantity;
        uint64 limitPrice;
    }

    function execute(State storage state, Liquidate memory liquidate, bytes32 accountID) internal {
        requireAdmin(state, accountID);
        Market storage market = listedMarket(state, liquidate.marketId);
        Account storage account = state.accounts[liquidate.account];
        int256 size = account.positions[liquidate.marketId].size;
        if (size == 0) revert NoPosition();
        (int256 equity,, uint256 maintenanceMargin) = health(state, liquidate.account);
        if (equity >= int256(maintenanceMargin)) revert NotLiquidatable();

        cancelAllOrders(state, account);
        uint256 notional = close(state, liquidate, size);
        chargeFee(state, liquidate.account, notional, market.liquidationFeeBps);
        untrackIfEmpty(account, liquidate.marketId);

        if (account.marketIds.length == 0 && account.collateral < 0) {
            state.insuranceFund += account.collateral;
            account.collateral = 0;
        }
    }

    function close(State storage state, Liquidate memory liquidate, int256 size) private returns (uint256) {
        uint64 quantity = uint64(abs(size)) < liquidate.quantity ? uint64(abs(size)) : liquidate.quantity;
        (uint64 filled, uint256 notional) = matchOrder(
            state,
            liquidate.account,
            liquidate.marketId,
            size > 0 ? Side.Sell : Side.Buy,
            quantity,
            liquidate.limitPrice
        );
        if (filled == 0) revert InsufficientLiquidity();
        return notional;
    }

    function cancelAllOrders(State storage state, Account storage account) private {
        for (uint256 i = account.marketIds.length; i > 0; i--) {
            uint64 marketId = account.marketIds[i - 1];
            Position storage position = account.positions[marketId];
            while (position.orderIds.length > 0) {
                removeOrder(state, position.orderIds[position.orderIds.length - 1]);
            }
            untrackIfEmpty(account, marketId);
        }
    }
}
