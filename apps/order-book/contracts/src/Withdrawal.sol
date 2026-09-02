// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {InsufficientBalance, State} from "./OrderBook.sol";

library WithdrawalMutation {
    struct Withdrawal {
        address asset;
        uint256 amount;
    }

    function executeWithdrawal(State storage state, Withdrawal memory withdrawal, bytes32 accountID) internal {
        if (state.accounts[accountID].balances[withdrawal.asset] < withdrawal.amount) {
            revert InsufficientBalance();
        }
        unchecked {
            state.accounts[accountID].balances[withdrawal.asset] -= withdrawal.amount;
        }
    }
}
