// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Typewriter, UnknownMutation} from "typewriter/Typewriter.sol";

struct Inner {
    uint256 a;
    uint256 b;
}

struct State {
    uint256 total;
}

library UpdateMutation {
    struct Update {
        Inner inner;
    }

    function executeUpdate(State storage state, Update memory update) internal {
        state.total += update.inner.a + update.inner.b;
    }
}

/// Fixture whose single mutation decodes a struct that itself contains a nested
/// struct member (`Inner`). Exercises the parser's handling of non-elementary
/// mutation params.
contract NestedParam is Typewriter {
    State internal state;

    enum Mutation {
        Update
    }

    constructor() {
        SCHEDULER = msg.sender;
        FORCE_INCLUSION_DELAY = 658;
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32) internal override {
        if (mutation == uint8(Mutation.Update)) {
            UpdateMutation.Update memory update = abi.decode(mutationData, (UpdateMutation.Update));
            UpdateMutation.executeUpdate(state, update);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
