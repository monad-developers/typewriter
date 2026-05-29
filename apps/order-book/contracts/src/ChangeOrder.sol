// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {LimitOrderMutation} from "./LimitOrder.sol";
import {
    Account,
    Instrument,
    Order,
    OrderNotFound,
    PERM_CHANGE_ORDER,
    Signature,
    State,
    Tick,
    TickPartiallyFilled,
    Unauthorized,
    verifyMutationSignature
} from "./Exchange.sol";

library ChangeOrderMutation {
    struct ChangeOrder {
        uint64 orderId;
        uint64 price;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 constant CHANGE_ORDER_TYPEHASH =
        keccak256("ChangeOrder(uint64 orderId,uint64 price,uint256 nonce,uint256 deadline)");

    function hashChangeOrder(ChangeOrder memory changeOrder) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CHANGE_ORDER_TYPEHASH, changeOrder.orderId, changeOrder.price, changeOrder.nonce, changeOrder.deadline
            )
        );
    }

    function verifyChangeOrderSignature(
        State storage state,
        ChangeOrder memory changeOrder,
        Signature memory signature,
        bytes32 digest
    ) internal {
        uint16 permissions = verifyMutationSignature(state, signature, digest, changeOrder.nonce, changeOrder.deadline);
        if ((permissions & PERM_CHANGE_ORDER) == 0) revert Unauthorized();
    }

    function executeChangeOrder(State storage state, ChangeOrder memory changeOrder, Signature memory signature)
        internal
    {
        Account storage account = state.accounts[signature.account];
        Order storage order = account.orders[changeOrder.orderId];
        uint64 orderQuantity = order.quantity;
        if (orderQuantity == 0) revert OrderNotFound();

        uint64 orderPrice = order.price;
        uint64 instrumentId = order.instrumentId;
        uint8 orderSide = order.side;
        Instrument storage instrument = state.instruments[instrumentId];
        mapping(uint64 => Tick) storage ticks = orderSide == 0 ? instrument.bids : instrument.asks;
        Tick storage tick = ticks[orderPrice];

        if (tick.quantity < orderQuantity || tick.volume != order.tickVolume || tick.remainingQuantity != tick.quantity)
        {
            revert TickPartiallyFilled();
        }

        unchecked {
            tick.quantity -= orderQuantity;
            tick.remainingQuantity -= orderQuantity;
        }

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
                bidOrAsk: orderSide,
                nonce: changeOrder.nonce,
                deadline: changeOrder.deadline
            }),
            signature
        );
    }
}
