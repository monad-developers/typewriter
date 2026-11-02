// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {State, listedMarket, requireAdmin} from "./Perps.sol";

/// Adds a funding payment per lot to each market's index: longs pay shorts
/// when it is positive. The admin computes it offchain, since the contract
/// can't store how much time has passed.
library AccrueFundingMutation {
    struct Funding {
        uint64 marketId;
        int256 fundingPerLot;
    }

    struct AccrueFunding {
        Funding[] fundings;
    }

    function execute(State storage state, AccrueFunding memory accrue, bytes32 accountID) internal {
        requireAdmin(state, accountID);
        for (uint256 i; i < accrue.fundings.length; i++) {
            Funding memory funding = accrue.fundings[i];
            listedMarket(state, funding.marketId).cumulativeFunding += funding.fundingPerLot;
        }
    }
}
