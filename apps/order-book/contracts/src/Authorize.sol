// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {KeyType} from "typewriter/FFCA.sol";
import {Key, PERM_AUTHORIZE, Signature, State, Unauthorized, verifyMutationSignature} from "./Exchange.sol";

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
        uint16 permissions = verifyMutationSignature(state, signature, digest, authorize.nonce, authorize.deadline);
        if ((permissions & PERM_AUTHORIZE) == 0) revert Unauthorized();
    }

    function executeAuthorize(State storage state, Authorize memory authorize, Signature memory signature) internal {
        state.accounts[signature.account].keys
            .push(Key(authorize.expiry, KeyType(authorize.keyType), authorize.permissions, authorize.publicKey));
    }
}
