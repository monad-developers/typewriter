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
    toLots,
    verifyMutationSignature
} from "./Exchange.sol";

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

    struct MarketOrderResolution {
        Fill[] fills;
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

    function executeMarketOrder(
        State storage state,
        MarketOrder memory order,
        MarketOrderResolution memory resolution,
        Signature memory signature
    ) internal {
        Instrument storage instrument = state.instruments[order.instrumentId];
        if (instrument.base == address(0)) revert InvalidInstrument();

        uint64 quantityLots = toLots(order.quantity, instrument.baseLotExp);
        uint8 receivedLotExp = order.bidOrAsk == 0 ? instrument.baseLotExp : instrument.quoteLotExp;
        uint64 minReceivedLots = toLots(order.minReceivedQuantity, receivedLotExp);

        uint256 totalFilled;
        uint256 totalReceived;
        for (uint256 i; i < resolution.fills.length;) {
            Fill memory fill = resolution.fills[i];
            settleFill(state, fill, instrument, order.bidOrAsk, signature.account);

            unchecked {
                totalFilled += fill.quantity;
                if (order.bidOrAsk == 0) {
                    totalReceived += fill.quantity;
                } else {
                    totalReceived += (uint256(fill.quantity) * uint256(fill.price)) >> 32;
                }
                ++i;
            }
        }

        if (totalFilled != quantityLots) revert InvalidMutation();
        if (totalReceived < minReceivedLots) revert SlippageExceeded();
    }

    function settleFill(
        State storage state,
        Fill memory fill,
        Instrument storage instrument,
        uint8 takerSide,
        bytes32 takerAccount
    ) private {
        mapping(uint64 => Tick) storage ticks = takerSide == 0 ? instrument.asks : instrument.bids;
        Tick storage tick = ticks[fill.price];

        if (fill.quantity > tick.remainingQuantity) revert InvalidTick();

        unchecked {
            tick.remainingQuantity -= fill.quantity;
        }
        if (tick.remainingQuantity == 0) {
            tick.volume++;
            tick.quantity = 0;
        }

        address base = instrument.base;
        address quote = instrument.quote;
        uint256 rawBase = uint256(fill.quantity) << instrument.baseLotExp;
        uint256 rawQuote = ((uint256(fill.quantity) * uint256(fill.price)) >> 32) << instrument.quoteLotExp;
        Account storage taker = state.accounts[takerAccount];

        if (takerSide == 0) {
            if (taker.balances[quote] < rawQuote) revert InsufficientBalance();
            unchecked {
                taker.balances[quote] -= rawQuote;
            }
            taker.balances[base] += rawBase;
        } else {
            if (taker.balances[base] < rawBase) revert InsufficientBalance();
            unchecked {
                taker.balances[base] -= rawBase;
            }
            taker.balances[quote] += rawQuote;
        }
    }
}
