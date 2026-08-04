// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    Account,
    PAINT_COST,
    PERM_PAINT,
    Signature,
    State,
    Unauthorized,
    WrongTeam,
    applyHit,
    pixelIndex,
    spendEnergy,
    teamOfColor,
    verifyMutationSignature
} from "./PixelWar.sol";

library PaintMutation {
    struct Paint {
        uint16 x;
        uint16 y;
        uint8 color;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 constant PAINT_TYPEHASH = keccak256("Paint(uint16 x,uint16 y,uint8 color,uint256 nonce,uint256 deadline)");

    function hashPaint(Paint memory paint) internal pure returns (bytes32) {
        return keccak256(abi.encode(PAINT_TYPEHASH, paint.x, paint.y, paint.color, paint.nonce, paint.deadline));
    }

    function verifyPaintSignature(State storage state, Paint memory paint, Signature memory signature, bytes32 digest)
        internal
    {
        uint16 permissions = verifyMutationSignature(state, signature, digest, paint.nonce, paint.deadline);
        if ((permissions & PERM_PAINT) == 0) revert Unauthorized();
    }

    /// Paints one pixel in one of the account team's shades. Energy is spent even
    /// when a shield absorbs the hit — chewing through shields is the cost of
    /// taking defended ground.
    function executePaint(State storage state, Paint memory paint, Signature memory signature) internal {
        Account storage account = state.accounts[signature.account];
        if (teamOfColor(paint.color) != account.team) revert WrongTeam();

        uint32 index = pixelIndex(paint.x, paint.y);
        spendEnergy(state, account, PAINT_COST);

        if (applyHit(state, index, paint.color)) {
            unchecked {
                account.painted += 1;
            }
        }
    }
}
