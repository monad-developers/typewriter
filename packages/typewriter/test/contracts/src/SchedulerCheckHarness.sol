// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {
    EXECUTE_TYPEHASH,
    SchedulerAuthorization,
    SchedulerCredential,
    Typewriter,
    UnknownMutation
} from "typewriter/Typewriter.sol";

/// Measures what `execute`'s scheduler credential check costs, for the gas
/// tables in gas.ts. Test-only: it is not part of any app.
contract SchedulerCheckHarness is Typewriter {
    /// The gas between two `gasleft()` reads.
    error GasUsed(uint256 gas);

    constructor(SchedulerCredential[] memory schedulerCredentials) Typewriter(schedulerCredentials) {}

    function dispatch(uint8 mutation, bytes memory, bytes32) internal pure override {
        revert UnknownMutation(mutation);
    }

    /// Reverts with the gas of the code that ends `execute`: its digest and
    /// `_authorizeScheduler`, as `execute` runs them.
    function measureCheck(
        bytes32 fromExecutionHash,
        bytes32 toExecutionHash,
        uint40 timestamp,
        SchedulerAuthorization calldata authorization
    ) external view {
        uint256 start = gasleft();
        bytes32 structHash =
            keccak256(abi.encode(EXECUTE_TYPEHASH, fromExecutionHash, toExecutionHash, timestamp, msg.sender));
        _authorizeScheduler(
            authorization, timestamp, keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash))
        );
        uint256 used = start - gasleft();
        revert GasUsed(used);
    }

    /// Reverts with the gas of two `gasleft()` reads around nothing, which
    /// `measureCheck`'s result includes.
    function measureNothing(
        bytes32 fromExecutionHash,
        bytes32 toExecutionHash,
        uint40 timestamp,
        SchedulerAuthorization calldata authorization
    ) external view {
        uint256 start = gasleft();
        uint256 used = start - gasleft();
        revert GasUsed(used);
    }
}
