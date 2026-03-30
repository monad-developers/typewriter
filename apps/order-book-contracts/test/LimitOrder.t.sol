// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {
    Exchange,
    LimitOrder,
    LimitOrderResolution,
    Fill,
    InvalidInstrument,
    InvalidAccount,
    FillPriceExceedsLimit,
    TickPartiallyFilled,
    InsufficientBalance
} from "src/Exchange.sol";

contract LimitOrderTest is Test, Exchange(address(0)) {
    function setUp() public {
        state.assets.push(address(0));
        state.assets.push(address(0));

        state.instruments.push();
        state.instruments[0].baseId = 0;
        state.instruments[0].quoteId = 1;

        state.accounts.push();
        state.accounts[0].balances[0] = 1000e18;
        state.accounts[0].balances[1] = 1000e18;

        // Ask liquidity at tick 10 for buy fills
        state.instruments[0].asks[10].quantity = 100e18;
        state.instruments[0].asks[10].remainingQuantity = 100e18;

        // Bid liquidity at tick 10 for sell fills
        state.instruments[0].bids[10].quantity = 100e18;
        state.instruments[0].bids[10].remainingQuantity = 100e18;
    }

    function callLimitOrder(LimitOrder memory order, LimitOrderResolution memory res) external {
        _executeLimitOrder(order, res);
    }

    function test_LimitOrder_InvalidInstrument() external {
        Fill[] memory fills = new Fill[](0);

        try this.callLimitOrder(
            LimitOrder({quantity: 1e18, marketId: 99, accountId: 0, tickId: 10, bidOrAsk: 0}),
            LimitOrderResolution({fills: fills})
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InvalidInstrument.selector);
        }
    }

    function test_LimitOrder_InvalidAccount() external {
        Fill[] memory fills = new Fill[](0);

        try this.callLimitOrder(
            LimitOrder({quantity: 1e18, marketId: 0, accountId: 99, tickId: 10, bidOrAsk: 0}),
            LimitOrderResolution({fills: fills})
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InvalidAccount.selector);
        }
    }

    function test_LimitOrder_FullyFilledImmediately() external {
        vm.pauseGasMetering();

        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 10e18, tickId: 10});

        vm.resumeGasMetering();

        _executeLimitOrder(
            LimitOrder({quantity: 10e18, marketId: 0, accountId: 0, tickId: 10, bidOrAsk: 0}),
            LimitOrderResolution({fills: fills})
        );

        vm.pauseGasMetering();

        assertEq(state.accounts[0].balances[0], 1010e18);
        assertEq(state.accounts[0].balances[1], 900e18);
        assertEq(state.accounts[0].orders.length, 0);

        vm.resumeGasMetering();
    }

    function test_LimitOrder_PartialFillAndRest() external {
        vm.pauseGasMetering();

        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 5e18, tickId: 10});

        vm.resumeGasMetering();

        _executeLimitOrder(
            LimitOrder({quantity: 10e18, marketId: 0, accountId: 0, tickId: 15, bidOrAsk: 0}),
            LimitOrderResolution({fills: fills})
        );

        vm.pauseGasMetering();

        // Filled 5e18 base at price 10 → paid 50e18 quote
        // Resting 5e18 at tick 15 → locked 5e18 * 15 = 75e18 quote
        assertEq(state.accounts[0].balances[0], 1005e18);
        assertEq(state.accounts[0].balances[1], 1000e18 - 50e18 - 75e18);

        assertEq(state.accounts[0].orders.length, 1);
        assertEq(state.accounts[0].orders[0].quantity, 5e18);
        assertEq(state.accounts[0].orders[0].tickId, 15);

        assertEq(state.instruments[0].bids[15].quantity, 5e18);
        assertEq(state.instruments[0].bids[15].remainingQuantity, 5e18);

        vm.resumeGasMetering();
    }

    function test_LimitOrder_FullyResting() external {
        vm.pauseGasMetering();

        Fill[] memory fills = new Fill[](0);

        vm.resumeGasMetering();

        _executeLimitOrder(
            LimitOrder({quantity: 10e18, marketId: 0, accountId: 0, tickId: 20, bidOrAsk: 0}),
            LimitOrderResolution({fills: fills})
        );

        vm.pauseGasMetering();

        assertEq(state.accounts[0].balances[1], 800e18);
        assertEq(state.accounts[0].orders.length, 1);
        assertEq(state.accounts[0].orders[0].quantity, 10e18);
        assertEq(state.instruments[0].bids[20].quantity, 10e18);
        assertEq(state.instruments[0].bids[20].remainingQuantity, 10e18);

        vm.resumeGasMetering();
    }

    function test_LimitOrder_FillPriceExceedsLimitBid() external {
        vm.pauseGasMetering();

        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 5e18, tickId: 10});

        vm.resumeGasMetering();

        try this.callLimitOrder(
            LimitOrder({quantity: 5e18, marketId: 0, accountId: 0, tickId: 5, bidOrAsk: 0}),
            LimitOrderResolution({fills: fills})
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), FillPriceExceedsLimit.selector);
        }
    }

    function test_LimitOrder_FillPriceExceedsLimitAsk() external {
        vm.pauseGasMetering();

        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 5e18, tickId: 10});

        vm.resumeGasMetering();

        try this.callLimitOrder(
            LimitOrder({quantity: 5e18, marketId: 0, accountId: 0, tickId: 20, bidOrAsk: 1}),
            LimitOrderResolution({fills: fills})
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), FillPriceExceedsLimit.selector);
        }
    }

    function test_LimitOrder_TickPartiallyFilled() external {
        vm.pauseGasMetering();

        state.instruments[0].bids[10].quantity = 50e18;
        state.instruments[0].bids[10].remainingQuantity = 30e18;

        Fill[] memory fills = new Fill[](0);

        vm.resumeGasMetering();

        try this.callLimitOrder(
            LimitOrder({quantity: 10e18, marketId: 0, accountId: 0, tickId: 10, bidOrAsk: 0}),
            LimitOrderResolution({fills: fills})
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TickPartiallyFilled.selector);
        }
    }

    function test_LimitOrder_InsufficientBalanceBid() external {
        vm.pauseGasMetering();

        state.accounts[0].balances[1] = 0;
        Fill[] memory fills = new Fill[](0);

        vm.resumeGasMetering();

        try this.callLimitOrder(
            LimitOrder({quantity: 10e18, marketId: 0, accountId: 0, tickId: 10, bidOrAsk: 0}),
            LimitOrderResolution({fills: fills})
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InsufficientBalance.selector);
        }
    }

    function test_LimitOrder_InsufficientBalanceAsk() external {
        vm.pauseGasMetering();

        state.accounts[0].balances[0] = 0;
        Fill[] memory fills = new Fill[](0);

        vm.resumeGasMetering();

        try this.callLimitOrder(
            LimitOrder({quantity: 10e18, marketId: 0, accountId: 0, tickId: 10, bidOrAsk: 1}),
            LimitOrderResolution({fills: fills})
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InsufficientBalance.selector);
        }
    }
}
