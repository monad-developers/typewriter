// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    Account,
    Instrument,
    Order,
    OrderNotFound,
    PERM_CLOSE_ORDER,
    Signature,
    State,
    Tick,
    Unauthorized,
    getTicks,
    removeBookTick,
    verifyMutationSignature
} from "./OrderBook.sol";

library CloseOrderMutation {
    struct CloseOrder {
        uint64 orderId;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 constant CLOSE_ORDER_TYPEHASH = keccak256("CloseOrder(uint64 orderId,uint256 nonce,uint256 deadline)");

    function hashCloseOrder(CloseOrder memory closeOrder) internal pure returns (bytes32) {
        return keccak256(abi.encode(CLOSE_ORDER_TYPEHASH, closeOrder.orderId, closeOrder.nonce, closeOrder.deadline));
    }

    function verifyCloseOrderSignature(
        State storage state,
        CloseOrder memory closeOrder,
        Signature memory signature,
        bytes32 digest
    ) internal {
        uint16 permissions = verifyMutationSignature(state, signature, digest, closeOrder.nonce, closeOrder.deadline);
        if ((permissions & PERM_CLOSE_ORDER) == 0) revert Unauthorized();
    }

    function executeCloseOrder(State storage state, CloseOrder memory closeOrder, Signature memory signature) internal {
        Account storage account = state.accounts[signature.account];
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
