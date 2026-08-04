// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    Account,
    KeyNotFound,
    PERM_REVOKE,
    Signature,
    State,
    Unauthorized,
    verifyMutationSignature
} from "./PixelWar.sol";

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
        if (revoke.account != signature.account) revert Unauthorized();
        uint16 permissions = verifyMutationSignature(state, signature, digest, revoke.nonce, revoke.deadline);
        if ((permissions & PERM_REVOKE) == 0) revert Unauthorized();
    }

    /// Zeroing the permission mask retires the key; `verifyMutationSignature`
    /// treats a zero mask as a missing key.
    function executeRevoke(State storage state, Revoke memory revoke, Signature memory signature) internal {
        Account storage account = state.accounts[signature.account];
        if (revoke.keyId >= account.keys.length) revert KeyNotFound();
        account.keys[revoke.keyId].permissions = 0;
    }
}
