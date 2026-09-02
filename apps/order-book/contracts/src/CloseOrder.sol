// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Account, Instrument, Order, OrderNotFound, State, Tick, getTicks, removeBookTick} from "./OrderBook.sol";

library CloseOrderMutation {
    struct CloseOrder {
        uint64 orderId;
    }

    function executeCloseOrder(State storage state, CloseOrder memory closeOrder, bytes32 accountID) internal {
        Account storage account = state.accounts[accountID];
        Order storage order = account.orders[closeOrder.orderId];
        uint64 orderQuantity = order.quantity;
        if (orderQuantity == 0) revert OrderNotFound();

        uint64 orderPrice = order.price;
        uint8 orderSide = order.side;
        Instrument storage instrument = state.instruments[order.instrumentId];
        mapping(uint64 => Tick) storage ticks = getTicks(instrument, orderSide);
        Tick storage tick = ticks[orderPrice];

        uint64 filledQuantity;
        uint64 unfilledQuantity;
        if (tick.volume > order.tickVolume) {
            filledQuantity = orderQuantity;
        } else {
            unchecked {
                uint256 consumed = tick.quantity - tick.remainingQuantity;
                filledQuantity = uint64((uint256(orderQuantity) * consumed) / tick.quantity);
                unfilledQuantity = orderQuantity - filledQuantity;
            }
        }

        if (unfilledQuantity > 0) {
            unchecked {
                tick.quantity -= unfilledQuantity;
                tick.remainingQuantity -= unfilledQuantity;
            }
            if (tick.quantity == 0) removeBookTick(instrument, orderSide, orderPrice);
        }

        if (orderSide == 0) {
            account.balances[
                    instrument.quote
                ] += ((uint256(unfilledQuantity) * uint256(orderPrice)) >> 32) << instrument.quoteLotExp;
            account.balances[instrument.base] += uint256(filledQuantity) << instrument.baseLotExp;
        } else {
            account.balances[instrument.base] += uint256(unfilledQuantity) << instrument.baseLotExp;
            account.balances[
                    instrument.quote
                ] += ((uint256(filledQuantity) * uint256(orderPrice)) >> 32) << instrument.quoteLotExp;
        }

        delete account.orders[closeOrder.orderId];
    }
}
