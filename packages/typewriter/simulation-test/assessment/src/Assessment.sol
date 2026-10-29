// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Typewriter, UnknownMutation} from "typewriter/Typewriter.sol";

struct State {
    /// A hash over every executed mutation, in execution order.
    bytes32 accumulator;
    mapping(uint256 => bytes32) slots;
}

error InvalidScheduler();
error AError();
error BError();

library AMutation {
    struct A {
        uint256 slot;
        uint256 value;
        bool shouldRevert;
    }
}

library BMutation {
    struct B {
        uint256 slot;
        uint256 value;
        bool shouldRevert;
    }
}

contract Assessment is Typewriter {
    State internal state;

    enum Mutation {
        A,
        B
    }

    constructor(address _scheduler, uint256 _forceInclusionDelay) {
        if (_scheduler == address(0)) revert InvalidScheduler();
        SCHEDULER = _scheduler;
        FORCE_INCLUSION_DELAY = _forceInclusionDelay;
    }

    /// A mutation reverts when `shouldRevert` is set, so a failure depends only on the input.
    function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID) internal override {
        if (mutation == uint8(Mutation.A)) {
            AMutation.A memory a = abi.decode(mutationData, (AMutation.A));
            if (a.shouldRevert) revert AError();
            state.slots[a.slot] = bytes32(a.value);
            state.accumulator = keccak256(abi.encode(state.accumulator, uint8(0), accountID, a.slot, a.value));
        } else if (mutation == uint8(Mutation.B)) {
            BMutation.B memory b = abi.decode(mutationData, (BMutation.B));
            if (b.shouldRevert) revert BError();
            state.slots[b.slot] = keccak256(abi.encode(b.value));
            state.accumulator = keccak256(abi.encode(state.accumulator, uint8(1), accountID, b.slot, b.value));
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
