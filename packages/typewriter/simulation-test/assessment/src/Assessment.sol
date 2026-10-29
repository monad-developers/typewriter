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

/// Reverts when `shouldRevert` is set, so a failure depends only on the input.
library AMutation {
    struct A {
        uint256 slot;
        uint256 value;
        bool shouldRevert;
    }

    function execute(State storage state, A memory a, bytes32 accountID) internal {
        if (a.shouldRevert) revert AError();
        state.slots[a.slot] = bytes32(a.value);
        state.accumulator = keccak256(abi.encode(state.accumulator, uint8(0), accountID, a.slot, a.value));
    }
}

/// Reverts when `shouldRevert` is set, so a failure depends only on the input.
library BMutation {
    struct B {
        uint256 slot;
        uint256 value;
        bool shouldRevert;
    }

    function execute(State storage state, B memory b, bytes32 accountID) internal {
        if (b.shouldRevert) revert BError();
        state.slots[b.slot] = keccak256(abi.encode(b.value));
        state.accumulator = keccak256(abi.encode(state.accumulator, uint8(1), accountID, b.slot, b.value));
    }
}

contract Assessment is Typewriter {
    State internal state;

    enum Mutation {
        A,
        B
    }

    constructor(address _scheduler) {
        if (_scheduler == address(0)) revert InvalidScheduler();
        SCHEDULER = _scheduler;
    }

    function forceInclusionDelay() internal pure override returns (uint256) {
        return 365 days;
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID) internal override {
        if (mutation == uint8(Mutation.A)) {
            AMutation.A memory a = abi.decode(mutationData, (AMutation.A));
            AMutation.execute(state, a, accountID);
        } else if (mutation == uint8(Mutation.B)) {
            BMutation.B memory b = abi.decode(mutationData, (BMutation.B));
            BMutation.execute(state, b, accountID);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
