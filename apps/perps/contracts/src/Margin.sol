// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Account, BPS, InsufficientMargin, Market, Position, Side, SizeOverflow, State} from "./Perps.sol";

function abs(int256 value) pure returns (uint256) {
    return value < 0 ? uint256(-value) : uint256(value);
}

function signed(uint64 value) pure returns (int256) {
    return int256(uint256(value));
}

function trackMarket(Account storage account, uint64 marketId) {
    Position storage position = account.positions[marketId];
    if (position.index != 0) return;
    account.marketIds.push(marketId);
    position.index = uint32(account.marketIds.length);
}

/// Drops `marketId` from the markets an account's health iterates once it
/// has no position or resting orders there.
function untrackIfEmpty(Account storage account, uint64 marketId) {
    Position storage position = account.positions[marketId];
    if (position.index == 0 || position.size != 0 || position.orderIds.length != 0) return;
    uint64 moved = account.marketIds[account.marketIds.length - 1];
    account.marketIds[position.index - 1] = moved;
    account.positions[moved].index = position.index;
    account.marketIds.pop();
    position.index = 0;
}

function settleFunding(Account storage account, Market storage market, Position storage position) {
    int256 cumulativeFunding = market.cumulativeFunding;
    account.collateral -= int256(position.size) * (cumulativeFunding - position.fundingIndex);
    position.fundingIndex = cumulativeFunding;
}

/// Trades `quantity` lots at `price` into the account's position, realizing
/// PnL on the part that closes it.
function applyFill(State storage state, bytes32 accountID, uint64 marketId, Side side, uint64 quantity, uint64 price) {
    Account storage account = state.accounts[accountID];
    Market storage market = state.markets[marketId];
    Position storage position = account.positions[marketId];
    settleFunding(account, market, position);
    trackMarket(account, marketId);

    int256 oldSize = position.size;
    int256 size = oldSize;
    int256 cost = position.cost;
    int256 delta = side == Side.Buy ? signed(quantity) : -signed(quantity);
    int256 fillPrice = signed(price);

    if (size != 0 && (size > 0) != (delta > 0)) {
        uint256 closed = abs(delta) < abs(size) ? abs(delta) : abs(size);
        int256 removedCost = (cost * int256(closed)) / int256(abs(size));
        int256 proceeds = int256(closed) * fillPrice;
        account.collateral += size > 0 ? proceeds - removedCost : -proceeds - removedCost;
        cost -= removedCost;
        size += size > 0 ? -int256(closed) : int256(closed);
        delta += delta > 0 ? -int256(closed) : int256(closed);
    }
    size += delta;
    cost += delta * fillPrice;

    if (size > type(int64).max || size < type(int64).min) revert SizeOverflow();
    position.size = int64(size);
    position.cost = cost;
    market.openInterest = uint64(
        uint256(
            int256(uint256(market.openInterest)) - (oldSize > 0 ? oldSize : int256(0)) + (size > 0 ? size : int256(0))
        )
    );
}

/// The larger of the position's size if every resting bid fills or if every
/// resting ask fills.
function worstCaseSize(Position storage position) view returns (uint256) {
    int256 size = position.size;
    uint256 ifBidsFill = abs(size + signed(position.bidLots));
    uint256 ifAsksFill = abs(size - signed(position.askLots));
    return ifBidsFill > ifAsksFill ? ifBidsFill : ifAsksFill;
}

/// Equity marks every position at the oracle price, net of unsettled funding.
function health(State storage state, bytes32 accountID)
    view
    returns (int256 equity, uint256 initialMargin, uint256 maintenanceMargin)
{
    Account storage account = state.accounts[accountID];
    equity = account.collateral;
    for (uint256 i; i < account.marketIds.length; i++) {
        uint64 marketId = account.marketIds[i];
        Market storage market = state.markets[marketId];
        Position storage position = account.positions[marketId];
        int256 size = position.size;
        uint256 mark = market.oraclePrice;
        equity += size * int256(mark) - position.cost - size * (market.cumulativeFunding - position.fundingIndex);
        initialMargin += (worstCaseSize(position) * mark * market.initialMarginBps) / BPS;
        maintenanceMargin += (abs(size) * mark * market.maintenanceMarginBps) / BPS;
    }
}

function requireInitialMargin(State storage state, bytes32 accountID) view {
    (int256 equity, uint256 initialMargin,) = health(state, accountID);
    if (equity < int256(initialMargin)) revert InsufficientMargin();
}

function chargeFee(State storage state, bytes32 accountID, uint256 notional, uint16 feeBps) {
    int256 fee = int256((notional * feeBps) / BPS);
    state.accounts[accountID].collateral -= fee;
    state.insuranceFund += fee;
}
