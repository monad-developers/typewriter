// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {
    Exchange,
    MarketOrder,
    MarketOrderResolution,
    Fill,
    InvalidInstrument,
    InvalidMutation,
    SlippageExceeded,
    InsufficientBalance
} from "src/Exchange.sol";

contract MarketOrderTest is Test, Exchange(address(0)) {
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

        state.instruments[0].asks[10 * Q32].quantity = 100;
        state.instruments[0].asks[10 * Q32].remainingQuantity = 100;

        state.instruments[0].bids[10 * Q32].quantity = 100;
        state.instruments[0].bids[10 * Q32].remainingQuantity = 100;
    }

    function callMarketOrder(MarketOrder memory order, MarketOrderResolution memory res, bytes32 account) external {
        _executeMarketOrder(order, res, account);
    }

    function test_MarketOrder_InvalidInstrument() external {
        Fill[] memory fills = new Fill[](0);

        try this.callMarketOrder(
            MarketOrder({quantity: 1, minReceivedQuantity: 0, instrumentId: 99, bidOrAsk: 0, nonce: 0, deadline: 0}),
            MarketOrderResolution({fills: fills}),
            ACCOUNT
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InvalidInstrument.selector);
        }
    }

    function test_MarketOrder_BuyFill() external {
        vm.pauseGasMetering();

        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 10, price: 10 * Q32});

        vm.resumeGasMetering();

        _executeMarketOrder(
            MarketOrder({quantity: 10, minReceivedQuantity: 0, instrumentId: 0, bidOrAsk: 0, nonce: 0, deadline: 0}),
            MarketOrderResolution({fills: fills}),
            ACCOUNT
        );

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[BASE], 1010);
        assertEq(state.accounts[ACCOUNT].balances[QUOTE], 900);

        assertEq(state.instruments[0].asks[10 * Q32].remainingQuantity, 90);

        vm.resumeGasMetering();
    }

    function test_MarketOrder_SellFill() external {
        vm.pauseGasMetering();

        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 10, price: 10 * Q32});

        vm.resumeGasMetering();

        _executeMarketOrder(
            MarketOrder({quantity: 10, minReceivedQuantity: 0, instrumentId: 0, bidOrAsk: 1, nonce: 0, deadline: 0}),
            MarketOrderResolution({fills: fills}),
            ACCOUNT
        );

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[BASE], 990);
        assertEq(state.accounts[ACCOUNT].balances[QUOTE], 1100);

        assertEq(state.instruments[0].bids[10 * Q32].remainingQuantity, 90);

        vm.resumeGasMetering();
    }

    function test_MarketOrder_MultipleFills() external {
        vm.pauseGasMetering();

        state.instruments[0].asks[20 * Q32].quantity = 50;
        state.instruments[0].asks[20 * Q32].remainingQuantity = 50;

        Fill[] memory fills = new Fill[](2);
        fills[0] = Fill({quantity: 10, price: 10 * Q32});
        fills[1] = Fill({quantity: 5, price: 20 * Q32});

        vm.resumeGasMetering();

        _executeMarketOrder(
            MarketOrder({quantity: 15, minReceivedQuantity: 0, instrumentId: 0, bidOrAsk: 0, nonce: 0, deadline: 0}),
            MarketOrderResolution({fills: fills}),
            ACCOUNT
        );

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[BASE], 1015);
        assertEq(state.accounts[ACCOUNT].balances[QUOTE], 800);

        vm.resumeGasMetering();
    }

    function test_MarketOrder_NotFullyFilled() external {
        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 5, price: 10 * Q32});

        try this.callMarketOrder(
            MarketOrder({quantity: 10, minReceivedQuantity: 0, instrumentId: 0, bidOrAsk: 0, nonce: 0, deadline: 0}),
            MarketOrderResolution({fills: fills}),
            ACCOUNT
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InvalidMutation.selector);
        }
    }

    function test_MarketOrder_SlippageExceeded() external {
        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 10, price: 10 * Q32});

        try this.callMarketOrder(
            MarketOrder({quantity: 10, minReceivedQuantity: 999, instrumentId: 0, bidOrAsk: 0, nonce: 0, deadline: 0}),
            MarketOrderResolution({fills: fills}),
            ACCOUNT
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), SlippageExceeded.selector);
        }
    }

    function test_MarketOrder_InsufficientBalance() external {
        vm.pauseGasMetering();

        state.accounts[ACCOUNT].balances[QUOTE] = 0;

        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 10, price: 10 * Q32});

        vm.resumeGasMetering();

        try this.callMarketOrder(
            MarketOrder({quantity: 10, minReceivedQuantity: 0, instrumentId: 0, bidOrAsk: 0, nonce: 0, deadline: 0}),
            MarketOrderResolution({fills: fills}),
            ACCOUNT
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InsufficientBalance.selector);
        }
    }

    function test_MarketOrder_BuyFillWithLotExp() external {
        vm.pauseGasMetering();

        state.instruments[0].baseLotExp = 18;
        state.instruments[0].quoteLotExp = 6;

        state.accounts[ACCOUNT].balances[BASE] = 0;
        state.accounts[ACCOUNT].balances[QUOTE] = 1000 << 6;

        state.instruments[0].asks[10 * Q32].quantity = 100;
        state.instruments[0].asks[10 * Q32].remainingQuantity = 100;

        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 10, price: 10 * Q32});

        vm.resumeGasMetering();

        _executeMarketOrder(
            MarketOrder({
                quantity: 10 << 18,
                minReceivedQuantity: 0,
                instrumentId: 0,
                bidOrAsk: 0,
                nonce: 0,
                deadline: 0
            }),
            MarketOrderResolution({fills: fills}),
            ACCOUNT
        );

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[BASE], 10 << 18);
        assertEq(state.accounts[ACCOUNT].balances[QUOTE], (1000 << 6) - (100 << 6));

        vm.resumeGasMetering();
    }
}
