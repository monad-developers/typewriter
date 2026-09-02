// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {
    InvalidInstrument,
    TickPartiallyFilled,
    InsufficientBalance,
    AmountNotLotMultiple,
    State
} from "src/OrderBook.sol";
import {LimitOrderMutation} from "src/LimitOrder.sol";

contract LimitOrderTest is Test {
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

    function _executeLimitOrder(LimitOrderMutation.LimitOrder memory order, bytes32 account) internal {
        LimitOrderMutation.executeLimitOrder(state, order, account);
    }

    function callLimitOrder(LimitOrderMutation.LimitOrder memory order, bytes32 account) external {
        _executeLimitOrder(order, account);
    }

    function test_LimitOrder_InvalidInstrument() external {
        try this.callLimitOrder(
            LimitOrderMutation.LimitOrder({quantity: 1, instrumentId: 99, price: 10 * Q32, bidOrAsk: 0}), ACCOUNT
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InvalidInstrument.selector);
        }
    }

    function test_LimitOrder_PlaceBid() external {
        _executeLimitOrder(
            LimitOrderMutation.LimitOrder({quantity: 10, instrumentId: 0, price: 20 * Q32, bidOrAsk: 0}), ACCOUNT
        );

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[QUOTE], 800);
        assertEq(state.accounts[ACCOUNT].orders.length, 1);
        assertEq(state.accounts[ACCOUNT].orders[0].quantity, 10);
        assertEq(state.accounts[ACCOUNT].orders[0].price, 20 * Q32);
        assertEq(state.instruments[0].bids[20 * Q32].quantity, 10);
        assertEq(state.instruments[0].bids[20 * Q32].remainingQuantity, 10);

        vm.resumeGasMetering();
    }

    function test_LimitOrder_PlaceAsk() external {
        _executeLimitOrder(
            LimitOrderMutation.LimitOrder({quantity: 10, instrumentId: 0, price: 20 * Q32, bidOrAsk: 1}), ACCOUNT
        );

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[BASE], 990);
        assertEq(state.accounts[ACCOUNT].orders.length, 1);
        assertEq(state.accounts[ACCOUNT].orders[0].quantity, 10);
        assertEq(state.instruments[0].asks[20 * Q32].quantity, 10);
        assertEq(state.instruments[0].asks[20 * Q32].remainingQuantity, 10);

        vm.resumeGasMetering();
    }

    function test_LimitOrder_TickPartiallyFilled() external {
        vm.pauseGasMetering();

        state.instruments[0].bids[10 * Q32].quantity = 50;
        state.instruments[0].bids[10 * Q32].remainingQuantity = 30;

        vm.resumeGasMetering();

        try this.callLimitOrder(
            LimitOrderMutation.LimitOrder({quantity: 10, instrumentId: 0, price: 10 * Q32, bidOrAsk: 0}), ACCOUNT
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TickPartiallyFilled.selector);
        }
    }

    function test_LimitOrder_InsufficientBalanceBid() external {
        vm.pauseGasMetering();

        state.accounts[ACCOUNT].balances[QUOTE] = 0;

        vm.resumeGasMetering();

        try this.callLimitOrder(
            LimitOrderMutation.LimitOrder({quantity: 10, instrumentId: 0, price: 10 * Q32, bidOrAsk: 0}), ACCOUNT
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InsufficientBalance.selector);
        }
    }

    function test_LimitOrder_InsufficientBalanceAsk() external {
        vm.pauseGasMetering();

        state.accounts[ACCOUNT].balances[BASE] = 0;

        vm.resumeGasMetering();

        try this.callLimitOrder(
            LimitOrderMutation.LimitOrder({quantity: 10, instrumentId: 0, price: 10 * Q32, bidOrAsk: 1}), ACCOUNT
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InsufficientBalance.selector);
        }
    }

    function test_LimitOrder_PlaceBidWithLotExp() external {
        vm.pauseGasMetering();

        state.instruments[0].baseLotExp = 18;
        state.instruments[0].quoteLotExp = 6;

        state.accounts[ACCOUNT].balances[QUOTE] = 1000 << 6;

        vm.resumeGasMetering();

        _executeLimitOrder(
            LimitOrderMutation.LimitOrder({quantity: 10 << 18, instrumentId: 0, price: 5 * Q32, bidOrAsk: 0}), ACCOUNT
        );

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[QUOTE], (1000 << 6) - (50 << 6));
        assertEq(state.instruments[0].bids[5 * Q32].quantity, 10);

        vm.resumeGasMetering();
    }

    function test_LimitOrder_AmountNotLotMultiple() external {
        state.instruments[0].baseLotExp = 18;
        state.instruments[0].quoteLotExp = 6;

        try this.callLimitOrder(
            LimitOrderMutation.LimitOrder({quantity: (10 << 18) + 1, instrumentId: 0, price: 5 * Q32, bidOrAsk: 1}),
            ACCOUNT
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), AmountNotLotMultiple.selector);
        }
    }

    function test_LimitOrder_PlaceAskWithLotExp() external {
        vm.pauseGasMetering();

        state.instruments[0].baseLotExp = 18;
        state.instruments[0].quoteLotExp = 6;

        state.accounts[ACCOUNT].balances[BASE] = 100 << 18;

        vm.resumeGasMetering();

        _executeLimitOrder(
            LimitOrderMutation.LimitOrder({quantity: 10 << 18, instrumentId: 0, price: 5 * Q32, bidOrAsk: 1}), ACCOUNT
        );

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[BASE], (100 << 18) - (10 << 18));
        assertEq(state.instruments[0].asks[5 * Q32].quantity, 10);

        vm.resumeGasMetering();
    }
}
