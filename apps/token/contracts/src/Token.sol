// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Typewriter, UnknownMutation} from "typewriter/Typewriter.sol";

struct State {
    uint256 totalSupply;
    mapping(bytes32 => uint256) balances;
}

error InvalidScheduler();

import {MintMutation} from "./Mint.sol";
import {TransferMutation} from "./Transfer.sol";

contract Token is Typewriter {
    State internal state;

    enum Mutation {
        Transfer,
        Mint
    }

    constructor(address _scheduler) {
        if (_scheduler == address(0)) revert InvalidScheduler();
        SCHEDULER = _scheduler;
        FORCE_INCLUSION_DELAY = 658;
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID) internal override {
        if (mutation == uint8(Mutation.Transfer)) {
            TransferMutation.Transfer memory transfer = abi.decode(mutationData, (TransferMutation.Transfer));
            TransferMutation.execute(state, transfer, accountID);
        } else if (mutation == uint8(Mutation.Mint)) {
            MintMutation.Mint memory mint = abi.decode(mutationData, (MintMutation.Mint));
            MintMutation.execute(state, mint, accountID);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
