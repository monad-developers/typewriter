// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PERM_ADVANCE_EPOCH, Signature, StaleEpoch, State, Unauthorized, verifyMutationSignature} from "./PixelWar.sol";

library AdvanceEpochMutation {
    struct AdvanceEpoch {
        uint64 epoch;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 constant ADVANCE_EPOCH_TYPEHASH = keccak256("AdvanceEpoch(uint64 epoch,uint256 nonce,uint256 deadline)");

    function hashAdvanceEpoch(AdvanceEpoch memory advanceEpoch) internal pure returns (bytes32) {
        return
            keccak256(abi.encode(ADVANCE_EPOCH_TYPEHASH, advanceEpoch.epoch, advanceEpoch.nonce, advanceEpoch.deadline));
    }

    /// Restricted to the epoch authority. A player's root key holds every
    /// permission bit, so the permission mask alone would let anyone refill
    /// their own energy at will.
    function verifyAdvanceEpochSignature(
        State storage state,
        AdvanceEpoch memory advanceEpoch,
        Signature memory signature,
        bytes32 digest,
        bytes32 epochAuthority
    ) internal {
        if (signature.account != epochAuthority) revert Unauthorized();
        uint16 permissions =
            verifyMutationSignature(state, signature, digest, advanceEpoch.nonce, advanceEpoch.deadline);
        if ((permissions & PERM_ADVANCE_EPOCH) == 0) revert Unauthorized();
    }

    /// The target epoch is explicit so a delayed or replayed advance cannot skip
    /// the canvas forward more than one epoch.
    function executeAdvanceEpoch(State storage state, AdvanceEpoch memory advanceEpoch) internal {
        if (advanceEpoch.epoch != state.epoch + 1) revert StaleEpoch();
        state.epoch = advanceEpoch.epoch;
    }
}
