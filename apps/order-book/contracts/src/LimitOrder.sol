// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    Account,
    InsufficientBalance,
    Instrument,
    InvalidInstrument,
    Order,
    State,
    Tick,
    TickPartiallyFilled,
    getTicks,
    insertBookTick,
    toLots
} from "./OrderBook.sol";

library LimitOrderMutation {
    struct LimitOrder {
        uint256 quantity;
        uint64 instrumentId;
        uint64 price;
        uint8 bidOrAsk;
    }

    function executeLimitOrder(State storage state, LimitOrder memory order, bytes32 accountID) internal {
        Instrument storage instrument = state.instruments[order.instrumentId];
        address base = instrument.base;
        if (base == address(0)) revert InvalidInstrument();

        uint8 baseLotExp = instrument.baseLotExp;
        uint64 quantityLots = toLots(order.quantity, baseLotExp);

        mapping(uint64 => Tick) storage ticks = getTicks(instrument, order.bidOrAsk);
        Tick storage tick = ticks[order.price];

        uint64 currentQuantity = tick.quantity;
        if (tick.remainingQuantity != currentQuantity) revert TickPartiallyFilled();

        Account storage account = state.accounts[accountID];
        if (order.bidOrAsk == 0) {
            address quote = instrument.quote;
            uint256 rawLock = ((uint256(quantityLots) * uint256(order.price)) >> 32) << instrument.quoteLotExp;
            if (account.balances[quote] < rawLock) revert InsufficientBalance();
            unchecked {
                account.balances[quote] -= rawLock;
            }
        } else {
            uint256 rawBase = uint256(quantityLots) << baseLotExp;
            if (account.balances[base] < rawBase) revert InsufficientBalance();
            unchecked {
                account.balances[base] -= rawBase;
            }
        }

        uint64 newQuantity = currentQuantity + quantityLots;
        tick.quantity = newQuantity;
        tick.remainingQuantity = newQuantity;
        if (currentQuantity == 0) insertBookTick(instrument, order.bidOrAsk, order.price);

        account.orders
            .push(
                Order({
                    quantity: quantityLots,
                    instrumentId: order.instrumentId,
                    price: order.price,
                    tickVolume: tick.volume,
                    side: order.bidOrAsk
                })
            );
    }
}
