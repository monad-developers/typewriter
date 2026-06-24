// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    Account,
    Instrument,
    InsufficientBalance,
    InvalidInstrument,
    InvalidMutation,
    InvalidTick,
    PERM_MARKET_ORDER,
    Signature,
    SlippageExceeded,
    State,
    Tick,
    Unauthorized,
    removeBookTick,
    toLots,
    verifyMutationSignature
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
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 constant MARKET_ORDER_TYPEHASH = keccak256(
        "MarketOrder(uint256 quantity,uint256 minReceivedQuantity,uint64 instrumentId,uint8 bidOrAsk,uint256 nonce,uint256 deadline)"
    );

    function hashMarketOrder(MarketOrder memory order) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MARKET_ORDER_TYPEHASH,
                order.quantity,
                order.minReceivedQuantity,
                order.instrumentId,
                order.bidOrAsk,
                order.nonce,
                order.deadline
            )
        );
    }

    function verifyMarketOrderSignature(
        State storage state,
        MarketOrder memory order,
        Signature memory signature,
        bytes32 digest
    ) internal {
        uint16 permissions = verifyMutationSignature(state, signature, digest, order.nonce, order.deadline);
        if ((permissions & PERM_MARKET_ORDER) == 0) revert Unauthorized();
    }

    function executeMarketOrder(State storage state, MarketOrder memory order, Signature memory signature) internal {
        Instrument storage instrument = state.instruments[order.instrumentId];
        if (instrument.base == address(0)) revert InvalidInstrument();

        uint64 quantityLots = toLots(order.quantity, instrument.baseLotExp);
        uint8 receivedLotExp = order.bidOrAsk == 0 ? instrument.baseLotExp : instrument.quoteLotExp;
        uint64 minReceivedLots = toLots(order.minReceivedQuantity, receivedLotExp);

        uint256 totalReceived = order.bidOrAsk == 0
            ? fillBuy(instrument, state.accounts[signature.account], quantityLots)
            : fillSell(instrument, state.accounts[signature.account], quantityLots);

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
