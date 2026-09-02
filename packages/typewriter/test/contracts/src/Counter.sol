// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Typewriter, UnknownMutation} from "typewriter/Typewriter.sol";

struct State {
    uint256 total;
}

library AddMutation {
    struct Add {
        uint256 amount;
    }

    function execute(State storage state, Add memory add) internal {
        state.total += add.amount;
    }
}

contract Counter is Typewriter {
    State internal state;

    enum Mutation {
        Add
    }

    constructor() {
        SCHEDULER = msg.sender;
        FORCE_INCLUSION_DELAY = 658;
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32) internal override {
        if (mutation == uint8(Mutation.Add)) {
            AddMutation.Add memory add = abi.decode(mutationData, (AddMutation.Add));
            AddMutation.execute(state, add);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
