// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    Account,
    BOMB_COST,
    BOMB_RADIUS,
    HEIGHT,
    OutOfBounds,
    PERM_BOMB,
    Signature,
    State,
    Unauthorized,
    WIDTH,
    WrongTeam,
    applyHit,
    spendEnergy,
    teamOfColor,
    verifyMutationSignature
} from "./PixelWar.sol";

library BombMutation {
    struct Bomb {
        uint16 x;
        uint16 y;
        uint8 color;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 constant BOMB_TYPEHASH = keccak256("Bomb(uint16 x,uint16 y,uint8 color,uint256 nonce,uint256 deadline)");

    function hashBomb(Bomb memory bomb) internal pure returns (bytes32) {
        return keccak256(abi.encode(BOMB_TYPEHASH, bomb.x, bomb.y, bomb.color, bomb.nonce, bomb.deadline));
    }

    function verifyBombSignature(State storage state, Bomb memory bomb, Signature memory signature, bytes32 digest)
        internal
    {
        uint16 permissions = verifyMutationSignature(state, signature, digest, bomb.nonce, bomb.deadline);
        if ((permissions & PERM_BOMB) == 0) revert Unauthorized();
    }

    /// Repaints the square around (x, y), clipped to the canvas. Every `Bomb` in
    /// a batch runs after every `Paint`, so a bomb buries paints landing in the
    /// same tick — but shields, which ran first, still absorb it pixel by pixel.
    function executeBomb(State storage state, Bomb memory bomb, Signature memory signature) internal {
        Account storage account = state.accounts[signature.account];
        if (teamOfColor(bomb.color) != account.team) revert WrongTeam();

        if (bomb.x >= WIDTH || bomb.y >= HEIGHT) revert OutOfBounds();
        spendEnergy(state, account, BOMB_COST);

        uint32 minX = bomb.x < BOMB_RADIUS ? 0 : bomb.x - BOMB_RADIUS;
        uint32 minY = bomb.y < BOMB_RADIUS ? 0 : bomb.y - BOMB_RADIUS;
        uint32 maxX = bomb.x + BOMB_RADIUS >= WIDTH ? WIDTH - 1 : bomb.x + BOMB_RADIUS;
        uint32 maxY = bomb.y + BOMB_RADIUS >= HEIGHT ? HEIGHT - 1 : bomb.y + BOMB_RADIUS;

        uint32 painted = 0;
        for (uint32 y = minY; y <= maxY; y++) {
            for (uint32 x = minX; x <= maxX; x++) {
                if (applyHit(state, y * WIDTH + x, bomb.color)) painted++;
            }
        }
        unchecked {
            account.painted += painted;
        }
    }
}
