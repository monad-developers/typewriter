// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    Account,
    Instrument,
    InsufficientBalance,
    InvalidInstrument,
    InvalidMutation,
    InvalidTick,
    SlippageExceeded,
    State,
    Tick,
    removeBookTick,
    toLots
} from "./OrderBook.sol";

struct Fill {
    uint64 quantity;
    uint64 price;
}

library MarketOrderMutation {
    struct MarketOrder {
        uint256 quantity;
        uint256 minReceivedQuantity;
        uint64 instrumentId;
        uint8 bidOrAsk;
    }

    function executeMarketOrder(State storage state, MarketOrder memory order, bytes32 accountID) internal {
        Instrument storage instrument = state.instruments[order.instrumentId];
        if (instrument.base == address(0)) revert InvalidInstrument();

        uint64 quantityLots = toLots(order.quantity, instrument.baseLotExp);
        uint8 receivedLotExp = order.bidOrAsk == 0 ? instrument.baseLotExp : instrument.quoteLotExp;
        uint64 minReceivedLots = toLots(order.minReceivedQuantity, receivedLotExp);

        uint256 totalReceived = order.bidOrAsk == 0
            ? fillBuy(instrument, state.accounts[accountID], quantityLots)
            : fillSell(instrument, state.accounts[accountID], quantityLots);

        if (totalReceived < minReceivedLots) revert SlippageExceeded();
    }

    function fillBuy(Instrument storage instrument, Account storage taker, uint64 quantityLots)
        private
        returns (uint256 totalReceived)
    {
        mapping(uint64 => Tick) storage ticks = instrument.asks;
        uint64 remaining = quantityLots;
        uint64 price = instrument.bestAsk;
        while (remaining > 0) {
            if (price == 0) revert InvalidMutation();
            Tick storage tick = ticks[price];
            uint64 available = tick.remainingQuantity;
            uint64 next = tick.next;
            if (available == 0) {
                price = next;
                continue;
            }
            uint64 fillQuantity = remaining < available ? remaining : available;

            unchecked {
                remaining -= fillQuantity;
                consumeTick(tick, fillQuantity);
                uint256 rawQuote = ((uint256(fillQuantity) * uint256(price)) >> 32) << instrument.quoteLotExp;
                if (taker.balances[instrument.quote] < rawQuote) revert InsufficientBalance();
                taker.balances[instrument.quote] -= rawQuote;
                taker.balances[instrument.base] += uint256(fillQuantity) << instrument.baseLotExp;
                totalReceived += fillQuantity;
            }

            if (tick.remainingQuantity == 0) removeBookTick(instrument, 1, price);
            price = next;
        }
    }

    function fillSell(Instrument storage instrument, Account storage taker, uint64 quantityLots)
        private
        returns (uint256 totalReceived)
    {
        mapping(uint64 => Tick) storage ticks = instrument.bids;
        uint64 remaining = quantityLots;
        uint64 price = instrument.bestBid;
        while (remaining > 0) {
            if (price == 0) revert InvalidMutation();
            Tick storage tick = ticks[price];
            uint64 available = tick.remainingQuantity;
            uint64 next = tick.next;
            if (available == 0) {
                price = next;
                continue;
            }
            uint64 fillQuantity = remaining < available ? remaining : available;

            unchecked {
                remaining -= fillQuantity;
                consumeTick(tick, fillQuantity);
                uint256 rawBase = uint256(fillQuantity) << instrument.baseLotExp;
                if (taker.balances[instrument.base] < rawBase) revert InsufficientBalance();
                taker.balances[instrument.base] -= rawBase;
                uint256 quoteLots = (uint256(fillQuantity) * uint256(price)) >> 32;
                taker.balances[instrument.quote] += quoteLots << instrument.quoteLotExp;
                totalReceived += quoteLots;
            }

            if (tick.remainingQuantity == 0) removeBookTick(instrument, 0, price);
            price = next;
        }
    }

    function consumeTick(Tick storage tick, uint64 fillQuantity) private {
        if (fillQuantity > tick.remainingQuantity) revert InvalidTick();

        unchecked {
            tick.remainingQuantity -= fillQuantity;
        }
        if (tick.remainingQuantity == 0) {
            tick.volume++;
            tick.quantity = 0;
        }
    }
}
