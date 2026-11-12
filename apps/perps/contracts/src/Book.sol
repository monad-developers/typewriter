// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {applyFill, trackMarket, untrackIfEmpty} from "./Margin.sol";
import {Account, Level, Market, Order, Position, Side, State} from "./Perps.sol";

function levels(Market storage market, Side side) view returns (mapping(uint64 => Level) storage) {
    if (side == Side.Buy) return market.bids;
    return market.asks;
}

function bestPrice(Market storage market, Side side) view returns (uint64) {
    return side == Side.Buy ? market.bestBid : market.bestAsk;
}

function setBestPrice(Market storage market, Side side, uint64 price) {
    if (side == Side.Buy) market.bestBid = price;
    else market.bestAsk = price;
}

function isBetter(Side side, uint64 price, uint64 other) pure returns (bool) {
    return side == Side.Buy ? price > other : price < other;
}

function opposite(Side side) pure returns (Side) {
    return side == Side.Buy ? Side.Sell : Side.Buy;
}

function insertLevel(Market storage market, Side side, uint64 price) {
    mapping(uint64 => Level) storage book = levels(market, side);
    uint64 best = bestPrice(market, side);
    Level storage level = book[price];

    if (best == 0 || isBetter(side, price, best)) {
        level.next = best;
        if (best != 0) book[best].prev = price;
        setBestPrice(market, side, price);
        return;
    }

    uint64 current = best;
    while (true) {
        uint64 next = book[current].next;
        if (next == 0 || isBetter(side, price, next)) {
            level.prev = current;
            level.next = next;
            book[current].next = price;
            if (next != 0) book[next].prev = price;
            return;
        }
        current = next;
    }
}

function removeLevel(Market storage market, Side side, uint64 price) {
    mapping(uint64 => Level) storage book = levels(market, side);
    Level storage level = book[price];
    uint64 prev = level.prev;
    uint64 next = level.next;

    if (prev == 0) setBestPrice(market, side, next);
    else book[prev].next = next;
    if (next != 0) book[next].prev = prev;

    delete book[price];
}

function restOrder(State storage state, bytes32 accountID, uint64 marketId, Side side, uint64 price, uint64 quantity)
    returns (uint64 orderId)
{
    Market storage market = state.markets[marketId];
    Level storage level = levels(market, side)[price];
    Account storage account = state.accounts[accountID];
    Position storage position = account.positions[marketId];

    orderId = ++state.lastOrderId;
    Order storage order = state.orders[orderId];
    order.account = accountID;
    order.marketId = marketId;
    order.price = price;
    order.quantity = quantity;
    order.side = side;
    order.prev = level.tail;
    order.index = uint32(position.orderIds.length);
    position.orderIds.push(orderId);

    if (level.head == 0) {
        level.head = orderId;
        insertLevel(market, side, price);
    } else {
        state.orders[level.tail].next = orderId;
    }
    level.tail = orderId;
    level.quantity += quantity;

    if (side == Side.Buy) position.bidLots += quantity;
    else position.askLots += quantity;
    trackMarket(account, marketId);
}

/// Unlinks an order from its level and its owner's position, then deletes it.
function removeOrder(State storage state, uint64 orderId) {
    Order storage order = state.orders[orderId];
    uint64 marketId = order.marketId;
    uint64 price = order.price;
    uint64 quantity = order.quantity;
    Side side = order.side;
    Market storage market = state.markets[marketId];
    Level storage level = levels(market, side)[price];

    if (order.prev == 0) level.head = order.next;
    else state.orders[order.prev].next = order.next;
    if (order.next == 0) level.tail = order.prev;
    else state.orders[order.next].prev = order.prev;
    level.quantity -= quantity;
    if (level.head == 0) removeLevel(market, side, price);

    Position storage position = state.accounts[order.account].positions[marketId];
    if (side == Side.Buy) position.bidLots -= quantity;
    else position.askLots -= quantity;
    uint64[] storage orderIds = position.orderIds;
    uint64 moved = orderIds[orderIds.length - 1];
    orderIds[order.index] = moved;
    state.orders[moved].index = order.index;
    orderIds.pop();

    delete state.orders[orderId];
}

/// Fills up to `quantity` lots against resting orders no worse than
/// `limitPrice`, in price-time priority. Settles each maker and the taker at
/// each level's price. Cancels the taker's own resting orders it reaches.
function matchOrder(State storage state, bytes32 taker, uint64 marketId, Side side, uint64 quantity, uint64 limitPrice)
    returns (uint64 filled, uint256 notional)
{
    Side makerSide = opposite(side);
    uint64 price = bestPrice(state.markets[marketId], makerSide);

    while (filled < quantity && price != 0 && !isBetter(makerSide, limitPrice, price)) {
        uint64 nextPrice = levels(state.markets[marketId], makerSide)[price].next;
        uint64 levelFilled = fillLevel(state, taker, marketId, makerSide, price, quantity - filled);
        if (levelFilled > 0) {
            applyFill(state, taker, marketId, side, levelFilled, price);
            filled += levelFilled;
            notional += uint256(levelFilled) * price;
        }
        price = nextPrice;
    }
}

function fillLevel(State storage state, bytes32 taker, uint64 marketId, Side makerSide, uint64 price, uint64 quantity)
    returns (uint64 filled)
{
    Level storage level = levels(state.markets[marketId], makerSide)[price];
    uint64 orderId = level.head;
    while (orderId != 0 && filled < quantity) {
        Order storage order = state.orders[orderId];
        uint64 nextOrderId = order.next;
        bytes32 maker = order.account;
        if (maker == taker) {
            removeOrder(state, orderId);
            orderId = nextOrderId;
            continue;
        }

        uint64 fill = quantity - filled < order.quantity ? quantity - filled : order.quantity;
        if (fill == order.quantity) {
            removeOrder(state, orderId);
        } else {
            order.quantity -= fill;
            level.quantity -= fill;
            Position storage makerPosition = state.accounts[maker].positions[marketId];
            if (makerSide == Side.Buy) makerPosition.bidLots -= fill;
            else makerPosition.askLots -= fill;
        }
        applyFill(state, maker, marketId, makerSide, fill, price);
        untrackIfEmpty(state.accounts[maker], marketId);

        filled += fill;
        orderId = nextOrderId;
    }
}
