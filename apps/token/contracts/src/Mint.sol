// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {State} from "./Token.sol";

library MintMutation {
    struct Mint {
        uint256 amount;
    }

    function execute(State storage state, Mint memory mint, bytes32 accountID) internal {
        state.totalSupply += mint.amount;
        unchecked {
            state.balances[accountID] += mint.amount;
        }
    }
}
