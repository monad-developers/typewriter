// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {KeyType} from "typewriter/FFCA.sol";
import {Account, AlreadyInitialized, InvalidAccount, Key, Signature, State} from "./Exchange.sol";

library InitializeMutation {
    struct Initialize {
        bytes32 account;
        uint40 expiry;
        uint8 rootKeyType;
        uint8 keyType;
        uint16 permissions;
        bytes rootPublicKey;
        bytes publicKey;
    }

    bytes32 constant INITIALIZE_TYPEHASH = keccak256(
        "Initialize(bytes32 account,uint40 expiry,uint8 rootKeyType,uint8 keyType,uint16 permissions,bytes rootPublicKey,bytes publicKey)"
    );

    function hashInitialize(Initialize memory initialize) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                INITIALIZE_TYPEHASH,
                initialize.account,
                initialize.expiry,
                initialize.rootKeyType,
                initialize.keyType,
                initialize.permissions,
                keccak256(initialize.rootPublicKey),
                keccak256(initialize.publicKey)
            )
        );
    }

    function executeInitialize(State storage state, Initialize memory initialize, Signature memory signature) internal {
        if (signature.account != keccak256(initialize.rootPublicKey)) revert InvalidAccount();
        if (signature.account != initialize.account) revert InvalidAccount();

        Account storage account = state.accounts[signature.account];
        if (account.keys.length != 0) revert AlreadyInitialized();

        account.keys.push(Key(0, KeyType(initialize.rootKeyType), type(uint16).max, initialize.rootPublicKey));
        account.keys
            .push(Key(initialize.expiry, KeyType(initialize.keyType), initialize.permissions, initialize.publicKey));
    }
}
