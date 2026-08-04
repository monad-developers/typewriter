// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {KeyType} from "typewriter/Typewriter.sol";
import {
    Account,
    AlreadyInitialized,
    ENERGY_PER_EPOCH,
    InvalidAccount,
    Key,
    Signature,
    State,
    TEAM_COUNT
} from "./PixelWar.sol";

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

    /// Assigns the new player to whichever team has the fewest players. Ties go
    /// to the lowest team index, which keeps the choice deterministic — the
    /// framework has no usable source of randomness.
    function smallestTeam(State storage state) internal view returns (uint8 team) {
        uint32 fewest = state.teamPlayers[0];
        for (uint8 candidate = 1; candidate < TEAM_COUNT; candidate++) {
            uint32 players = state.teamPlayers[candidate];
            if (players < fewest) {
                fewest = players;
                team = candidate;
            }
        }
    }

    /// Bootstrap needs no signature: the account id is the hash of the root
    /// public key, so registering keys for someone else's key material grants
    /// nothing without their private key.
    function executeInitialize(State storage state, Initialize memory initialize, Signature memory signature) internal {
        if (signature.account != keccak256(initialize.rootPublicKey)) revert InvalidAccount();
        if (signature.account != initialize.account) revert InvalidAccount();

        Account storage account = state.accounts[signature.account];
        if (account.keys.length != 0) revert AlreadyInitialized();

        account.keys.push(Key(0, KeyType(initialize.rootKeyType), type(uint16).max, initialize.rootPublicKey));
        account.keys
            .push(Key(initialize.expiry, KeyType(initialize.keyType), initialize.permissions, initialize.publicKey));

        uint8 team = smallestTeam(state);
        account.team = team;
        account.epoch = state.epoch;
        account.energy = ENERGY_PER_EPOCH;
        unchecked {
            state.teamPlayers[team] += 1;
        }
    }
}
