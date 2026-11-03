// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {removeOrder} from "./Book.sol";
import {untrackIfEmpty} from "./Margin.sol";
import {NotOrderOwner, Order, OrderNotFound, State} from "./Perps.sol";

library CancelOrderMutation {
    struct CancelOrder {
        uint64 orderId;
    }

    function execute(State storage state, CancelOrder memory cancel, bytes32 accountID) internal {
        Order storage order = state.orders[cancel.orderId];
        if (order.quantity == 0) revert OrderNotFound();
        if (order.account != accountID) revert NotOrderOwner();
        uint64 marketId = order.marketId;
        removeOrder(state, cancel.orderId);
        untrackIfEmpty(state.accounts[accountID], marketId);
    }
}
