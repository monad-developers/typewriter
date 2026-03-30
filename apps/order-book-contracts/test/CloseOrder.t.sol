// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {
    Exchange,
    CloseOrder,
    Order,
    OrderNotFound,
    InvalidAccount
} from "src/Exchange.sol";

contract CloseOrderTest is Test, Exchange(address(0)) {
    function setUp() public {
        state.assets.push(address(0));
        state.assets.push(address(0));

        state.instruments.push();
        state.instruments[0].baseId = 0;
        state.instruments[0].quoteId = 1;

        state.accounts.push();
        state.accounts[0].balances[0] = 1000e18;
        state.accounts[0].balances[1] = 1000e18;
    }

    function callCloseOrder(CloseOrder memory close) external {
        _executeCloseOrder(close);
    }

    function test_CloseOrder_OrderNotFound() external {
        vm.pauseGasMetering();

        state.accounts[0].orders.push(Order({quantity: 0, marketId: 0, tickId: 0, tickVolume: 0, side: 0}));

        vm.resumeGasMetering();

        try this.callCloseOrder(CloseOrder({accountId: 0, orderId: 0})) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), OrderNotFound.selector);
        }
    }

    function test_CloseOrder_InvalidAccount() external {
        try this.callCloseOrder(CloseOrder({accountId: 99, orderId: 0})) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InvalidAccount.selector);
        }
    }

    function test_CloseOrder_TickFullyCrossed() external {
        vm.pauseGasMetering();

        state.instruments[0].bids[10].quantity = 50e18;
        state.instruments[0].bids[10].remainingQuantity = 50e18;
        state.accounts[0].orders.push(
            Order({quantity: 50e18, marketId: 0, tickId: 10, tickVolume: 0, side: 0})
        );

        // Tick has been fully crossed
        state.instruments[0].bids[10].volume = 1;

        uint256 quoteBefore = state.accounts[0].balances[1];

        vm.resumeGasMetering();

        _executeCloseOrder(CloseOrder({accountId: 0, orderId: 0}));

        vm.pauseGasMetering();

        // No refund
        assertEq(state.accounts[0].balances[1], quoteBefore);
        assertEq(state.accounts[0].orders[0].quantity, 0);

        vm.resumeGasMetering();
    }

    function test_CloseOrder_FullRefundBid() external {
        vm.pauseGasMetering();

        state.instruments[0].bids[10].quantity = 50e18;
        state.instruments[0].bids[10].remainingQuantity = 50e18;
        state.accounts[0].orders.push(
            Order({quantity: 50e18, marketId: 0, tickId: 10, tickVolume: 0, side: 0})
        );

        uint256 quoteBefore = state.accounts[0].balances[1];

        vm.resumeGasMetering();

        _executeCloseOrder(CloseOrder({accountId: 0, orderId: 0}));

        vm.pauseGasMetering();

        // Full refund: 50e18 * 10 = 500e18 quote
        assertEq(state.accounts[0].balances[1], quoteBefore + 500e18);
        assertEq(state.instruments[0].bids[10].quantity, 0);
        assertEq(state.instruments[0].bids[10].remainingQuantity, 0);

        vm.resumeGasMetering();
    }

    function test_CloseOrder_FullRefundAsk() external {
        vm.pauseGasMetering();

        state.instruments[0].asks[10].quantity = 50e18;
        state.instruments[0].asks[10].remainingQuantity = 50e18;
        state.accounts[0].orders.push(
            Order({quantity: 50e18, marketId: 0, tickId: 10, tickVolume: 0, side: 1})
        );

        uint256 baseBefore = state.accounts[0].balances[0];

        vm.resumeGasMetering();

        _executeCloseOrder(CloseOrder({accountId: 0, orderId: 0}));

        vm.pauseGasMetering();

        assertEq(state.accounts[0].balances[0], baseBefore + 50e18);

        vm.resumeGasMetering();
    }

    function test_CloseOrder_PartialRefund() external {
        vm.pauseGasMetering();

        // Bid at tick 10 with 100e18 total, 40e18 consumed
        state.instruments[0].bids[10].quantity = 100e18;
        state.instruments[0].bids[10].remainingQuantity = 60e18;
        state.accounts[0].orders.push(
            Order({quantity: 50e18, marketId: 0, tickId: 10, tickVolume: 0, side: 0})
        );

        // Pro-rata: filled = 50e18 * 40e18 / 100e18 = 20e18
        // Unfilled = 30e18. Refund = 30e18 * 10 = 300e18

        uint256 quoteBefore = state.accounts[0].balances[1];

        vm.resumeGasMetering();

        _executeCloseOrder(CloseOrder({accountId: 0, orderId: 0}));

        vm.pauseGasMetering();

        assertEq(state.accounts[0].balances[1], quoteBefore + 300e18);
        assertEq(state.instruments[0].bids[10].quantity, 70e18);
        assertEq(state.instruments[0].bids[10].remainingQuantity, 30e18);

        vm.resumeGasMetering();
    }
}
