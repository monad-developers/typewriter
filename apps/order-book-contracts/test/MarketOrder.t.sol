// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {
    Exchange,
    MarketOrder,
    MarketOrderResolution,
    Fill,
    InvalidInstrument,
    InvalidAccount,
    InvalidMutation,
    SlippageExceeded,
    InsufficientBalance
} from "src/Exchange.sol";

contract MarketOrderTest is Test, Exchange(address(0)) {
    function setUp() public {
        // Asset 0 = base, Asset 1 = quote
        state.assets.push(address(0));
        state.assets.push(address(0));

        // Instrument 0: baseId=0, quoteId=1
        state.instruments.push();
        state.instruments[0].baseId = 0;
        state.instruments[0].quoteId = 1;

        // Account 0
        state.accounts.push();
        state.accounts[0].balances[0] = 1000e18;
        state.accounts[0].balances[1] = 1000e18;

        // Seed ask liquidity at tick 10 (price=10): 100 base available
        state.instruments[0].asks[10].quantity = 100e18;
        state.instruments[0].asks[10].remainingQuantity = 100e18;

        // Seed bid liquidity at tick 10 (price=10): 100 base available
        state.instruments[0].bids[10].quantity = 100e18;
        state.instruments[0].bids[10].remainingQuantity = 100e18;
    }

    function test_MarketOrder_InvalidInstrument() external {
        Fill[] memory fills = new Fill[](0);

        try this.callMarketOrder(
            MarketOrder({quantity: 1e18, minReceivedQuantity: 0, marketId: 99, accountId: 0, bidOrAsk: 0}),
            MarketOrderResolution({fills: fills})
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InvalidInstrument.selector);
        }
    }

    function test_MarketOrder_InvalidAccount() external {
        Fill[] memory fills = new Fill[](0);

        try this.callMarketOrder(
            MarketOrder({quantity: 1e18, minReceivedQuantity: 0, marketId: 0, accountId: 99, bidOrAsk: 0}),
            MarketOrderResolution({fills: fills})
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InvalidAccount.selector);
        }
    }

    function callMarketOrder(MarketOrder memory order, MarketOrderResolution memory res) external {
        _executeMarketOrder(order, res);
    }

    function test_MarketOrder_BuyFill() external {
        vm.pauseGasMetering();

        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 10e18, tickId: 10});

        vm.resumeGasMetering();

        _executeMarketOrder(
            MarketOrder({quantity: 10e18, minReceivedQuantity: 0, marketId: 0, accountId: 0, bidOrAsk: 0}),
            MarketOrderResolution({fills: fills})
        );

        vm.pauseGasMetering();

        // Buyer pays 10e18 * 10 = 100e18 quote, receives 10e18 base
        assertEq(state.accounts[0].balances[0], 1010e18);
        assertEq(state.accounts[0].balances[1], 900e18);

        // Ask tick consumed
        assertEq(state.instruments[0].asks[10].remainingQuantity, 90e18);

        vm.resumeGasMetering();
    }

    function test_MarketOrder_SellFill() external {
        vm.pauseGasMetering();

        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 10e18, tickId: 10});

        vm.resumeGasMetering();

        _executeMarketOrder(
            MarketOrder({quantity: 10e18, minReceivedQuantity: 0, marketId: 0, accountId: 0, bidOrAsk: 1}),
            MarketOrderResolution({fills: fills})
        );

        vm.pauseGasMetering();

        // Seller pays 10e18 base, receives 10e18 * 10 = 100e18 quote
        assertEq(state.accounts[0].balances[0], 990e18);
        assertEq(state.accounts[0].balances[1], 1100e18);

        // Bid tick consumed
        assertEq(state.instruments[0].bids[10].remainingQuantity, 90e18);

        vm.resumeGasMetering();
    }

    function test_MarketOrder_MultipleFills() external {
        vm.pauseGasMetering();

        // Add a second ask tick at price 20
        state.instruments[0].asks[20].quantity = 50e18;
        state.instruments[0].asks[20].remainingQuantity = 50e18;

        Fill[] memory fills = new Fill[](2);
        fills[0] = Fill({quantity: 10e18, tickId: 10});
        fills[1] = Fill({quantity: 5e18, tickId: 20});

        vm.resumeGasMetering();

        _executeMarketOrder(
            MarketOrder({quantity: 15e18, minReceivedQuantity: 0, marketId: 0, accountId: 0, bidOrAsk: 0}),
            MarketOrderResolution({fills: fills})
        );

        vm.pauseGasMetering();

        // Paid: 10e18*10 + 5e18*20 = 200e18 quote. Received: 15e18 base
        assertEq(state.accounts[0].balances[0], 1015e18);
        assertEq(state.accounts[0].balances[1], 800e18);

        vm.resumeGasMetering();
    }

    function test_MarketOrder_NotFullyFilled() external {
        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 5e18, tickId: 10});

        try this.callMarketOrder(
            MarketOrder({quantity: 10e18, minReceivedQuantity: 0, marketId: 0, accountId: 0, bidOrAsk: 0}),
            MarketOrderResolution({fills: fills})
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InvalidMutation.selector);
        }
    }

    function test_MarketOrder_SlippageExceeded() external {
        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 10e18, tickId: 10});

        try this.callMarketOrder(
            MarketOrder({quantity: 10e18, minReceivedQuantity: 999e18, marketId: 0, accountId: 0, bidOrAsk: 0}),
            MarketOrderResolution({fills: fills})
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), SlippageExceeded.selector);
        }
    }

    function test_MarketOrder_InsufficientBalance() external {
        vm.pauseGasMetering();

        state.accounts[0].balances[1] = 0;

        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 10e18, tickId: 10});

        vm.resumeGasMetering();

        try this.callMarketOrder(
            MarketOrder({quantity: 10e18, minReceivedQuantity: 0, marketId: 0, accountId: 0, bidOrAsk: 0}),
            MarketOrderResolution({fills: fills})
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InsufficientBalance.selector);
        }
    }
}
