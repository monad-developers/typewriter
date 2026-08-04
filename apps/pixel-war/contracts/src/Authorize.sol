// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {KeyType} from "typewriter/Typewriter.sol";
import {Account, Key, PERM_AUTHORIZE, Signature, State, Unauthorized, verifyMutationSignature} from "./PixelWar.sol";

library AuthorizeMutation {
    struct Authorize {
        bytes32 account;
        uint40 expiry;
        uint8 keyType;
        uint16 permissions;
        bytes publicKey;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 constant AUTHORIZE_TYPEHASH = keccak256(
        "Authorize(bytes32 account,uint40 expiry,uint8 keyType,uint16 permissions,bytes publicKey,uint256 nonce,uint256 deadline)"
    );

    function hashAuthorize(Authorize memory authorize) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                AUTHORIZE_TYPEHASH,
                authorize.account,
                authorize.expiry,
                authorize.keyType,
                authorize.permissions,
                keccak256(authorize.publicKey),
                authorize.nonce,
                authorize.deadline
            )
        );
    }

    function verifyAuthorizeSignature(
        State storage state,
        Authorize memory authorize,
        Signature memory signature,
        bytes32 digest
    ) internal {
        if (authorize.account != signature.account) revert Unauthorized();
        uint16 permissions = verifyMutationSignature(state, signature, digest, authorize.nonce, authorize.deadline);
        if ((permissions & PERM_AUTHORIZE) == 0) revert Unauthorized();
    }

    /// Adds a delegate key. The new key can never hold permissions the signing
    /// key does not already have.
    function executeAuthorize(State storage state, Authorize memory authorize, Signature memory signature) internal {
        Account storage account = state.accounts[signature.account];
        uint16 granted = authorize.permissions & account.keys[signature.keyId].permissions;
        account.keys.push(Key(authorize.expiry, KeyType(authorize.keyType), granted, authorize.publicKey));
    }
}
