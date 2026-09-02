// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {LimitOrderMutation} from "./LimitOrder.sol";
import {
    Account,
    Instrument,
    Order,
    OrderNotFound,
    State,
    Tick,
    TickPartiallyFilled,
    getTicks,
    removeBookTick
} from "./OrderBook.sol";

library ChangeOrderMutation {
    struct ChangeOrder {
        uint64 orderId;
        uint64 price;
    }

    function executeChangeOrder(State storage state, ChangeOrder memory changeOrder, bytes32 accountID) internal {
        Account storage account = state.accounts[accountID];
        Order storage order = account.orders[changeOrder.orderId];
        uint64 orderQuantity = order.quantity;
        if (orderQuantity == 0) revert OrderNotFound();

        uint64 orderPrice = order.price;
        uint64 instrumentId = order.instrumentId;
        uint8 orderSide = order.side;
        Instrument storage instrument = state.instruments[instrumentId];
        mapping(uint64 => Tick) storage ticks = getTicks(instrument, orderSide);
        Tick storage tick = ticks[orderPrice];

        if (tick.quantity < orderQuantity || tick.volume != order.tickVolume || tick.remainingQuantity != tick.quantity)
        {
            revert TickPartiallyFilled();
        }

        unchecked {
            tick.quantity -= orderQuantity;
            tick.remainingQuantity -= orderQuantity;
        }
        if (tick.quantity == 0) removeBookTick(instrument, orderSide, orderPrice);

        if (orderSide == 0) {
            account.balances[
                    instrument.quote
                ] += ((uint256(orderQuantity) * uint256(orderPrice)) >> 32) << instrument.quoteLotExp;
        } else {
            account.balances[instrument.base] += uint256(orderQuantity) << instrument.baseLotExp;
        }

        delete account.orders[changeOrder.orderId];
        LimitOrderMutation.executeLimitOrder(
            state,
            LimitOrderMutation.LimitOrder({
                quantity: uint256(orderQuantity) << instrument.baseLotExp,
                instrumentId: instrumentId,
                price: changeOrder.price,
                bidOrAsk: orderSide
            }),
            accountID
        );
    }
}
