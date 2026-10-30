// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {Typewriter, UnknownMutation} from "typewriter/Typewriter.sol";

struct State {
    /// A hash over every executed mutation, in execution order.
    bytes32 accumulator;
    mapping(uint256 => bytes32) slots;
}

error InvalidScheduler();
error AError();
error BError();
error CError();

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

/// Holds a `string`, whose bytes need not be valid UTF-8 or free of NUL.
library CMutation {
    struct C {
        uint256 slot;
        string value;
        bool shouldRevert;
    }
}

contract Assessment is Typewriter {
    State internal state;

    enum Mutation {
        A,
        B,
        C
    }

    constructor(address _scheduler) Typewriter(_scheduler) {
        if (_scheduler == address(0)) revert InvalidScheduler();
        FORCE_INCLUSION_DELAY = 365 days;
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
        } else if (mutation == uint8(Mutation.C)) {
            CMutation.C memory c = abi.decode(mutationData, (CMutation.C));
            if (c.shouldRevert) revert CError();
            bytes32 hash = keccak256(bytes(c.value));
            state.slots[c.slot] = hash;
            state.accumulator = keccak256(abi.encode(state.accumulator, uint8(2), accountID, c.slot, hash));
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
