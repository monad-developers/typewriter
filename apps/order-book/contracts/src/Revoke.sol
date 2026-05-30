// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PERM_REVOKE, Signature, State, Unauthorized, verifyMutationSignature} from "./Exchange.sol";

library RevokeMutation {
    struct Revoke {
        bytes32 account;
        uint64 keyId;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 constant REVOKE_TYPEHASH = keccak256("Revoke(bytes32 account,uint64 keyId,uint256 nonce,uint256 deadline)");

    function hashRevoke(Revoke memory revoke) internal pure returns (bytes32) {
        return keccak256(abi.encode(REVOKE_TYPEHASH, revoke.account, revoke.keyId, revoke.nonce, revoke.deadline));
    }

    function verifyRevokeSignature(
        State storage state,
        Revoke memory revoke,
        Signature memory signature,
        bytes32 digest
    ) internal {
        uint16 permissions = verifyMutationSignature(state, signature, digest, revoke.nonce, revoke.deadline);
        if ((permissions & PERM_REVOKE) == 0) revert Unauthorized();
    }

    function executeRevoke(State storage state, Revoke memory revoke, Signature memory signature) internal {
        delete state.accounts[signature.account].keys[revoke.keyId];
    }
}
