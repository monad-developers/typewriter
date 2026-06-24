// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {Order, OrderNotFound, Signature, State} from "src/OrderBook.sol";
import {CloseOrderMutation} from "src/CloseOrder.sol";

contract CloseOrderTest is Test {
    State internal state;

    address constant BASE = address(1);
    address constant QUOTE = address(2);
    bytes32 constant ACCOUNT = bytes32(uint256(100));
    uint64 constant Q32 = 1 << 32;

    function setUp() public {
        state.instruments[0].base = BASE;
        state.instruments[0].quote = QUOTE;
        state.instruments[0].baseLotExp = 0;
        state.instruments[0].quoteLotExp = 0;

        state.accounts[ACCOUNT].balances[BASE] = 1000;
        state.accounts[ACCOUNT].balances[QUOTE] = 1000;
    }

    function _executeCloseOrder(CloseOrderMutation.CloseOrder memory close, bytes32 account) internal {
        CloseOrderMutation.executeCloseOrder(state, close, Signature({account: account, keyId: 0, rawSignature: ""}));
    }

    function callCloseOrder(CloseOrderMutation.CloseOrder memory close, bytes32 account) external {
        _executeCloseOrder(close, account);
    }

    function test_CloseOrder_OrderNotFound() external {
        vm.pauseGasMetering();

        state.accounts[ACCOUNT].orders.push(Order({quantity: 0, instrumentId: 0, price: 0, tickVolume: 0, side: 0}));

        vm.resumeGasMetering();

        try this.callCloseOrder(CloseOrderMutation.CloseOrder({orderId: 0, nonce: 0, deadline: 0}), ACCOUNT) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), OrderNotFound.selector);
        }
    }

    function test_CloseOrder_TickFullyCrossed() external {
        vm.pauseGasMetering();

        state.instruments[0].bids[10 * Q32].quantity = 50;
        state.instruments[0].bids[10 * Q32].remainingQuantity = 50;
        state.accounts[ACCOUNT].orders
            .push(Order({quantity: 50, instrumentId: 0, price: 10 * Q32, tickVolume: 0, side: 0}));

        state.instruments[0].bids[10 * Q32].volume = 1;

        uint256 quoteBefore = state.accounts[ACCOUNT].balances[QUOTE];

        vm.resumeGasMetering();

        _executeCloseOrder(CloseOrderMutation.CloseOrder({orderId: 0, nonce: 0, deadline: 0}), ACCOUNT);

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[QUOTE], quoteBefore);
        assertEq(state.accounts[ACCOUNT].balances[BASE], 1050);
        assertEq(state.accounts[ACCOUNT].orders[0].quantity, 0);

        vm.resumeGasMetering();
    }

    function test_CloseOrder_FullRefundBid() external {
        vm.pauseGasMetering();

        state.instruments[0].bids[10 * Q32].quantity = 50;
        state.instruments[0].bids[10 * Q32].remainingQuantity = 50;
        state.accounts[ACCOUNT].orders
            .push(Order({quantity: 50, instrumentId: 0, price: 10 * Q32, tickVolume: 0, side: 0}));

        uint256 quoteBefore = state.accounts[ACCOUNT].balances[QUOTE];

        vm.resumeGasMetering();

        _executeCloseOrder(CloseOrderMutation.CloseOrder({orderId: 0, nonce: 0, deadline: 0}), ACCOUNT);

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[QUOTE], quoteBefore + 500);
        assertEq(state.instruments[0].bids[10 * Q32].quantity, 0);
        assertEq(state.instruments[0].bids[10 * Q32].remainingQuantity, 0);

        vm.resumeGasMetering();
    }

    function test_CloseOrder_FullRefundAsk() external {
        vm.pauseGasMetering();

        state.instruments[0].asks[10 * Q32].quantity = 50;
        state.instruments[0].asks[10 * Q32].remainingQuantity = 50;
        state.accounts[ACCOUNT].orders
            .push(Order({quantity: 50, instrumentId: 0, price: 10 * Q32, tickVolume: 0, side: 1}));

        uint256 baseBefore = state.accounts[ACCOUNT].balances[BASE];

        vm.resumeGasMetering();

        _executeCloseOrder(CloseOrderMutation.CloseOrder({orderId: 0, nonce: 0, deadline: 0}), ACCOUNT);

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[BASE], baseBefore + 50);

        vm.resumeGasMetering();
    }

    function test_CloseOrder_PartialRefund() external {
        vm.pauseGasMetering();

        state.instruments[0].bids[10 * Q32].quantity = 100;
        state.instruments[0].bids[10 * Q32].remainingQuantity = 60;
        state.accounts[ACCOUNT].orders
            .push(Order({quantity: 50, instrumentId: 0, price: 10 * Q32, tickVolume: 0, side: 0}));

        uint256 quoteBefore = state.accounts[ACCOUNT].balances[QUOTE];

        vm.resumeGasMetering();

        _executeCloseOrder(CloseOrderMutation.CloseOrder({orderId: 0, nonce: 0, deadline: 0}), ACCOUNT);

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[QUOTE], quoteBefore + 300);
        assertEq(state.accounts[ACCOUNT].balances[BASE], 1020);
        assertEq(state.instruments[0].bids[10 * Q32].quantity, 70);
        assertEq(state.instruments[0].bids[10 * Q32].remainingQuantity, 30);

        vm.resumeGasMetering();
    }

    function test_CloseOrder_FullRefundBidWithLotExp() external {
        vm.pauseGasMetering();

        state.instruments[0].baseLotExp = 18;
        state.instruments[0].quoteLotExp = 6;

        state.accounts[ACCOUNT].balances[QUOTE] = 0;

        state.instruments[0].bids[10 * Q32].quantity = 50;
        state.instruments[0].bids[10 * Q32].remainingQuantity = 50;
        state.accounts[ACCOUNT].orders
            .push(Order({quantity: 50, instrumentId: 0, price: 10 * Q32, tickVolume: 0, side: 0}));

        vm.resumeGasMetering();

        _executeCloseOrder(CloseOrderMutation.CloseOrder({orderId: 0, nonce: 0, deadline: 0}), ACCOUNT);

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[QUOTE], 500 << 6);
        assertEq(state.instruments[0].bids[10 * Q32].quantity, 0);

        vm.resumeGasMetering();
    }

    function test_CloseOrder_FullRefundAskWithLotExp() external {
        vm.pauseGasMetering();

        state.instruments[0].baseLotExp = 18;
        state.instruments[0].quoteLotExp = 6;

        state.accounts[ACCOUNT].balances[BASE] = 0;

        state.instruments[0].asks[10 * Q32].quantity = 50;
        state.instruments[0].asks[10 * Q32].remainingQuantity = 50;
        state.accounts[ACCOUNT].orders
            .push(Order({quantity: 50, instrumentId: 0, price: 10 * Q32, tickVolume: 0, side: 1}));

        vm.resumeGasMetering();

        _executeCloseOrder(CloseOrderMutation.CloseOrder({orderId: 0, nonce: 0, deadline: 0}), ACCOUNT);

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[BASE], 50 << 18);

        vm.resumeGasMetering();
    }
}
