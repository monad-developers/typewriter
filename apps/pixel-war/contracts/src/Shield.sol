// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    Account,
    MAX_SHIELD_STACK,
    NotShieldable,
    PERM_SHIELD,
    SHIELD_COST,
    Signature,
    State,
    Unauthorized,
    pixelIndex,
    readPixel,
    spendEnergy,
    teamOfColor,
    verifyMutationSignature
} from "./PixelWar.sol";

library ShieldMutation {
    struct Shield {
        uint16 x;
        uint16 y;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 constant SHIELD_TYPEHASH = keccak256("Shield(uint16 x,uint16 y,uint256 nonce,uint256 deadline)");

    function hashShield(Shield memory shield) internal pure returns (bytes32) {
        return keccak256(abi.encode(SHIELD_TYPEHASH, shield.x, shield.y, shield.nonce, shield.deadline));
    }

    function verifyShieldSignature(
        State storage state,
        Shield memory shield,
        Signature memory signature,
        bytes32 digest
    ) internal {
        uint16 permissions = verifyMutationSignature(state, signature, digest, shield.nonce, shield.deadline);
        if ((permissions & PERM_SHIELD) == 0) revert Unauthorized();
    }

    /// Stacks one absorb charge onto a pixel the account's own team holds.
    /// Because the server orders every `Shield` in a batch ahead of every
    /// `Paint`, shielding in the same tick as an incoming paint saves the pixel.
    function executeShield(State storage state, Shield memory shield, Signature memory signature) internal {
        Account storage account = state.accounts[signature.account];
        uint32 index = pixelIndex(shield.x, shield.y);

        uint8 color = readPixel(state, index);
        if (color == 0 || teamOfColor(color) != account.team) revert NotShieldable();

        spendEnergy(state, account, SHIELD_COST);

        uint8 shields = state.shields[index];
        if (shields < MAX_SHIELD_STACK) {
            unchecked {
                state.shields[index] = shields + 1;
            }
        }
    }
}
