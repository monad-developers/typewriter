// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {requireInitialMargin} from "./Margin.sol";
import {Account, InsufficientCollateral, State} from "./Perps.sol";

/// Debits settled collateral, leaving initial margin for every position and
/// resting order. Paying it out happens outside the app.
library WithdrawalMutation {
    struct Withdrawal {
        uint256 amount;
    }

    function execute(State storage state, Withdrawal memory withdrawal, bytes32 accountID) internal {
        Account storage account = state.accounts[accountID];
        if (
            withdrawal.amount == 0 || withdrawal.amount > uint256(type(int256).max)
                || int256(withdrawal.amount) > account.collateral
        ) revert InsufficientCollateral();
        account.collateral -= int256(withdrawal.amount);
        requireInitialMargin(state, accountID);
    }
}
