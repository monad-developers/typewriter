// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Typewriter, KeyType, UnknownMutation, verifySignature} from "typewriter/Typewriter.sol";

// Canvas geometry. `WIDTH * HEIGHT` pixels, four bits of color per pixel, so
// `PIXELS_PER_WORD` pixels share one storage slot and the whole canvas fits in
// `CANVAS_WORDS` slots. A paint always writes exactly one slot.
uint32 constant WIDTH = 128;
uint32 constant HEIGHT = 128;
uint32 constant PIXEL_COUNT = WIDTH * HEIGHT;
uint32 constant PIXELS_PER_WORD = 64;
uint32 constant CANVAS_WORDS = PIXEL_COUNT / PIXELS_PER_WORD;

// Color 0 is bare canvas. Colors 1..12 are `TEAM_COUNT` teams of
// `SHADES_PER_TEAM` shades each, so a pixel's team is implied by its color and
// never needs its own storage.
uint8 constant TEAM_COUNT = 4;
uint8 constant SHADES_PER_TEAM = 3;
uint8 constant COLOR_COUNT = TEAM_COUNT * SHADES_PER_TEAM;

// Every account gets `ENERGY_PER_EPOCH` energy per epoch, and each action
// spends some of it. Epochs advance through the `AdvanceEpoch` mutation rather
// than a clock, so energy accounting stays byte-identical offchain and onchain.
uint32 constant ENERGY_PER_EPOCH = 30;
uint32 constant PAINT_COST = 1;
uint32 constant SHIELD_COST = 3;
uint32 constant BOMB_COST = 10;

// A shield absorbs whole hits instead of expiring on a timestamp, for the same
// determinism reason.
uint8 constant MAX_SHIELD_STACK = 3;

// Bombs cover a square of side `2 * BOMB_RADIUS + 1`, clipped at the edges.
uint32 constant BOMB_RADIUS = 1;

struct Key {
    uint40 expiry;
    KeyType keyType;
    uint16 permissions;
    bytes publicKey;
}

struct Account {
    uint64 epoch;
    uint32 energy;
    uint32 painted;
    uint8 team;
    Key[] keys;
    mapping(uint192 => uint64) nonces;
}

struct State {
    uint64 epoch;
    mapping(bytes32 => Account) accounts;
    uint256[CANVAS_WORDS] canvas;
    mapping(uint32 => uint8) shields;
    uint32[TEAM_COUNT] teamPixels;
    uint32[TEAM_COUNT] teamPlayers;
}

struct Signature {
    bytes32 account;
    uint64 keyId;
    bytes rawSignature;
}

uint16 constant PERM_AUTHORIZE = 1 << 0;
uint16 constant PERM_REVOKE = 1 << 1;
uint16 constant PERM_PAINT = 1 << 2;
uint16 constant PERM_SHIELD = 1 << 3;
uint16 constant PERM_BOMB = 1 << 4;
uint16 constant PERM_ADVANCE_EPOCH = 1 << 5;

error Unauthorized();
error SignatureExpired();
error InvalidNonce();
error InvalidAccount();
error AlreadyInitialized();
error KeyNotFound();
error KeyExpired();
error OutOfEnergy();
error OutOfBounds();
error InvalidColor();
error WrongTeam();
error NotShieldable();
error StaleEpoch();

function verifyMutationSignature(
    State storage state,
    Signature memory signature,
    bytes32 digest,
    uint256 nonce,
    uint256 deadline
) returns (uint16 permissions) {
    if (deadline < block.timestamp) revert SignatureExpired();

    Account storage account = state.accounts[signature.account];
    if (signature.keyId >= account.keys.length) revert KeyNotFound();
    Key storage key = account.keys[signature.keyId];
    if (key.permissions == 0) revert KeyNotFound();
    if (key.expiry != 0 && key.expiry < block.timestamp) revert KeyExpired();

    verifySignature(key.keyType, digest, key.publicKey, signature.rawSignature);

    uint192 nonceKey = uint192(nonce >> 64);
    uint64 nonceSeq = uint64(nonce);
    uint64 stored = account.nonces[nonceKey];
    if (nonceSeq != stored) revert InvalidNonce();
    unchecked {
        account.nonces[nonceKey] = stored + 1;
    }

    return key.permissions;
}

/// Refills the account's energy the first time it acts in a new epoch, then
/// charges `cost`. `state.epoch` only moves through `AdvanceEpoch`, so this is
/// pure state arithmetic with no environment inputs.
function spendEnergy(State storage state, Account storage account, uint32 cost) {
    if (account.epoch != state.epoch) {
        account.epoch = state.epoch;
        account.energy = ENERGY_PER_EPOCH;
    }
    if (account.energy < cost) revert OutOfEnergy();
    unchecked {
        account.energy -= cost;
    }
}

function pixelIndex(uint16 x, uint16 y) pure returns (uint32) {
    if (x >= WIDTH || y >= HEIGHT) revert OutOfBounds();
    return uint32(y) * WIDTH + uint32(x);
}

/// Colors are 1-indexed, so team `t` owns colors `t * SHADES_PER_TEAM + 1`
/// through `(t + 1) * SHADES_PER_TEAM`.
function teamOfColor(uint8 color) pure returns (uint8) {
    if (color == 0 || color > COLOR_COUNT) revert InvalidColor();
    unchecked {
        return (color - 1) / SHADES_PER_TEAM;
    }
}

function readPixel(State storage state, uint32 index) view returns (uint8) {
    uint256 shift = (index % PIXELS_PER_WORD) * 4;
    return uint8((state.canvas[index / PIXELS_PER_WORD] >> shift) & 0xf);
}

/// Writes one pixel and keeps the per-team pixel counters in step, so team
/// scores never need a scan of the canvas.
function writePixel(State storage state, uint32 index, uint8 color) {
    uint32 word = index / PIXELS_PER_WORD;
    uint256 shift = (index % PIXELS_PER_WORD) * 4;
    uint256 packed = state.canvas[word];
    uint8 previous = uint8((packed >> shift) & 0xf);
    if (previous == color) return;

    state.canvas[word] = (packed & ~(uint256(0xf) << shift)) | (uint256(color) << shift);

    unchecked {
        if (previous != 0) state.teamPixels[teamOfColor(previous)] -= 1;
        if (color != 0) state.teamPixels[teamOfColor(color)] += 1;
    }
}

/// Applies one hit to `index`. A shielded pixel absorbs the hit and loses a
/// shield charge instead of changing color. Returns true when the pixel was
/// painted.
function applyHit(State storage state, uint32 index, uint8 color) returns (bool) {
    uint8 shield = state.shields[index];
    if (shield != 0) {
        unchecked {
            state.shields[index] = shield - 1;
        }
        return false;
    }
    writePixel(state, index, color);
    return true;
}

import {AdvanceEpochMutation} from "./AdvanceEpoch.sol";
import {AuthorizeMutation} from "./Authorize.sol";
import {BombMutation} from "./Bomb.sol";
import {InitializeMutation} from "./Initialize.sol";
import {PaintMutation} from "./Paint.sol";
import {RevokeMutation} from "./Revoke.sol";
import {ShieldMutation} from "./Shield.sol";

/// A pixel canvas where the batch order is the rulebook: within one batch every
/// `Shield` lands before every `Paint`, and every `Paint` before every `Bomb`.
contract PixelWar is Typewriter {
    /// Declaration order is the batch order the server is configured with.
    enum Mutation {
        Initialize,
        Authorize,
        Revoke,
        AdvanceEpoch,
        Shield,
        Paint,
        Bomb
    }

    State internal state;

    /// The only account allowed to advance epochs, derived from the scheduler
    /// key so it needs no storage and cannot drift from the server's config.
    bytes32 internal immutable EPOCH_AUTHORITY;

    constructor(address _scheduler) {
        if (_scheduler == address(0)) revert InvalidAccount();
        SCHEDULER = _scheduler;
        FORCE_INCLUSION_DELAY = 658;
        EPOCH_AUTHORITY = keccak256(abi.encode(_scheduler));
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes memory signatureData) internal override {
        if (Mutation(mutation) == Mutation.Initialize) {
            InitializeMutation.Initialize memory initialize = abi.decode(mutationData, (InitializeMutation.Initialize));
            Signature memory signature = abi.decode(signatureData, (Signature));

            InitializeMutation.executeInitialize(state, initialize, signature);
        } else if (Mutation(mutation) == Mutation.Authorize) {
            AuthorizeMutation.Authorize memory authorize = abi.decode(mutationData, (AuthorizeMutation.Authorize));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest =
                keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, AuthorizeMutation.hashAuthorize(authorize)));

            AuthorizeMutation.verifyAuthorizeSignature(state, authorize, signature, digest);
            AuthorizeMutation.executeAuthorize(state, authorize, signature);
        } else if (Mutation(mutation) == Mutation.Revoke) {
            RevokeMutation.Revoke memory revoke = abi.decode(mutationData, (RevokeMutation.Revoke));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest =
                keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, RevokeMutation.hashRevoke(revoke)));

            RevokeMutation.verifyRevokeSignature(state, revoke, signature, digest);
            RevokeMutation.executeRevoke(state, revoke, signature);
        } else if (Mutation(mutation) == Mutation.AdvanceEpoch) {
            AdvanceEpochMutation.AdvanceEpoch memory advanceEpoch =
                abi.decode(mutationData, (AdvanceEpochMutation.AdvanceEpoch));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest = keccak256(
                abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, AdvanceEpochMutation.hashAdvanceEpoch(advanceEpoch))
            );

            AdvanceEpochMutation.verifyAdvanceEpochSignature(state, advanceEpoch, signature, digest, EPOCH_AUTHORITY);
            AdvanceEpochMutation.executeAdvanceEpoch(state, advanceEpoch);
        } else if (Mutation(mutation) == Mutation.Shield) {
            ShieldMutation.Shield memory shield = abi.decode(mutationData, (ShieldMutation.Shield));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest =
                keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, ShieldMutation.hashShield(shield)));

            ShieldMutation.verifyShieldSignature(state, shield, signature, digest);
            ShieldMutation.executeShield(state, shield, signature);
        } else if (Mutation(mutation) == Mutation.Paint) {
            PaintMutation.Paint memory paint = abi.decode(mutationData, (PaintMutation.Paint));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, PaintMutation.hashPaint(paint)));

            PaintMutation.verifyPaintSignature(state, paint, signature, digest);
            PaintMutation.executePaint(state, paint, signature);
        } else if (Mutation(mutation) == Mutation.Bomb) {
            BombMutation.Bomb memory bomb = abi.decode(mutationData, (BombMutation.Bomb));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, BombMutation.hashBomb(bomb)));

            BombMutation.verifyBombSignature(state, bomb, signature, digest);
            BombMutation.executeBomb(state, bomb, signature);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
