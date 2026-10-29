// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {Typewriter} from "typewriter/Typewriter.sol";

/// Takes an argument besides the scheduler, so typewriter cannot deploy it.
contract ExtraConstructorArg is Typewriter {
    constructor(address scheduler, uint256) Typewriter(scheduler) {}

    function dispatch(uint8, bytes memory, bytes32) internal override {}
}
