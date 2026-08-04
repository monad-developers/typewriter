// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {
    AlreadyInitialized,
    ENERGY_PER_EPOCH,
    InvalidAccount,
    InvalidColor,
    InvalidNonce,
    KeyExpired,
    KeyNotFound,
    MAX_SHIELD_STACK,
    NotShieldable,
    OutOfBounds,
    OutOfEnergy,
    PERM_ADVANCE_EPOCH,
    PERM_AUTHORIZE,
    PERM_BOMB,
    PERM_PAINT,
    PERM_REVOKE,
    PERM_SHIELD,
    Signature,
    SignatureExpired,
    StaleEpoch,
    State,
    TEAM_COUNT,
    Unauthorized,
    WrongTeam,
    pixelIndex,
    readPixel
} from "src/PixelWar.sol";
import {AdvanceEpochMutation} from "src/AdvanceEpoch.sol";
import {AuthorizeMutation} from "src/Authorize.sol";
import {BombMutation} from "src/Bomb.sol";
import {InitializeMutation} from "src/Initialize.sol";
import {PaintMutation} from "src/Paint.sol";
import {RevokeMutation} from "src/Revoke.sol";
import {ShieldMutation} from "src/Shield.sol";

import {EIP712_DOMAIN_TYPEHASH, KeyType} from "typewriter/Typewriter.sol";

uint16 constant ALL_PERMISSIONS =
    PERM_AUTHORIZE | PERM_REVOKE | PERM_PAINT | PERM_SHIELD | PERM_BOMB | PERM_ADVANCE_EPOCH;

contract PixelWarTest is Test {
    State internal state;
    bytes32 internal DOMAIN_SEPARATOR;

    uint256 internal alicePk = 0xA11CE;
    uint256 internal aliceSessionPk = 0xA11CE5E55;
    uint256 internal bobPk = 0xB0B;
    uint256 internal bobSessionPk = 0xB0B5E55;

    bytes32 internal alice;
    bytes32 internal bob;

    // Team 0 gets colors 1..3, team 1 gets 4..6.
    uint8 internal constant RED = 1;
    uint8 internal constant RED_DARK = 2;
    uint8 internal constant BLUE = 4;

    function setUp() public {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Typewriter")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
        alice = keccak256(abi.encode(vm.addr(alicePk)));
        bob = keccak256(abi.encode(vm.addr(bobPk)));
        _initAccount(alicePk, aliceSessionPk, alice, ALL_PERMISSIONS);
        _initAccount(bobPk, bobSessionPk, bob, ALL_PERMISSIONS);
    }

    function _sign(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encode(v, r, s);
    }

    function _signature(bytes32 account, uint64 keyId, uint256 pk, bytes32 structHash)
        internal
        view
        returns (Signature memory)
    {
        return Signature({account: account, keyId: keyId, rawSignature: _sign(pk, structHash)});
    }

    function _initAccount(uint256 rootPk, uint256 sessionPk, bytes32 account, uint16 permissions) internal {
        InitializeMutation.Initialize memory init = InitializeMutation.Initialize({
            account: account,
            expiry: 0,
            rootKeyType: uint8(KeyType.Secp256k1),
            keyType: uint8(KeyType.Secp256k1),
            permissions: permissions,
            rootPublicKey: abi.encode(vm.addr(rootPk)),
            publicKey: abi.encode(vm.addr(sessionPk))
        });
        InitializeMutation.executeInitialize(state, init, Signature({account: account, keyId: 0, rawSignature: ""}));
    }

    function _paint(bytes32 account, uint256 pk, uint16 x, uint16 y, uint8 color, uint256 nonce) internal {
        PaintMutation.Paint memory paint =
            PaintMutation.Paint({x: x, y: y, color: color, nonce: nonce, deadline: type(uint256).max});
        Signature memory signature = _signature(account, 1, pk, PaintMutation.hashPaint(paint));
        PaintMutation.verifyPaintSignature(state, paint, signature, _digest(PaintMutation.hashPaint(paint)));
        PaintMutation.executePaint(state, paint, signature);
    }

    function _shield(bytes32 account, uint256 pk, uint16 x, uint16 y, uint256 nonce) internal {
        ShieldMutation.Shield memory shield =
            ShieldMutation.Shield({x: x, y: y, nonce: nonce, deadline: type(uint256).max});
        Signature memory signature = _signature(account, 1, pk, ShieldMutation.hashShield(shield));
        ShieldMutation.verifyShieldSignature(state, shield, signature, _digest(ShieldMutation.hashShield(shield)));
        ShieldMutation.executeShield(state, shield, signature);
    }

    function _bomb(bytes32 account, uint256 pk, uint16 x, uint16 y, uint8 color, uint256 nonce) internal {
        BombMutation.Bomb memory bomb =
            BombMutation.Bomb({x: x, y: y, color: color, nonce: nonce, deadline: type(uint256).max});
        Signature memory signature = _signature(account, 1, pk, BombMutation.hashBomb(bomb));
        BombMutation.verifyBombSignature(state, bomb, signature, _digest(BombMutation.hashBomb(bomb)));
        BombMutation.executeBomb(state, bomb, signature);
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _pixel(uint16 x, uint16 y) internal view returns (uint8) {
        return readPixel(state, pixelIndex(x, y));
    }

    // `vm.expectRevert` only sees reverts raised below the cheatcode's call
    // depth, and mutation libraries are internal. Reverting cases go through
    // these external wrappers so the revert happens one frame down.

    function callPaint(bytes32 account, uint256 pk, uint16 x, uint16 y, uint8 color, uint256 nonce) external {
        _paint(account, pk, x, y, color, nonce);
    }

    function callShield(bytes32 account, uint256 pk, uint16 x, uint16 y, uint256 nonce) external {
        _shield(account, pk, x, y, nonce);
    }

    function callBomb(bytes32 account, uint256 pk, uint16 x, uint16 y, uint8 color, uint256 nonce) external {
        _bomb(account, pk, x, y, color, nonce);
    }

    function callInitAccount(uint256 rootPk, uint256 sessionPk, bytes32 account, uint16 permissions) external {
        _initAccount(rootPk, sessionPk, account, permissions);
    }

    function callInitialize(InitializeMutation.Initialize memory init, Signature memory signature) external {
        InitializeMutation.executeInitialize(state, init, signature);
    }

    function callVerifyPaint(PaintMutation.Paint memory paint, Signature memory signature) external {
        PaintMutation.verifyPaintSignature(state, paint, signature, _digest(PaintMutation.hashPaint(paint)));
    }

    function callVerifyAdvanceEpoch(
        AdvanceEpochMutation.AdvanceEpoch memory advance,
        Signature memory signature,
        bytes32 authority
    ) external {
        AdvanceEpochMutation.verifyAdvanceEpochSignature(
            state, advance, signature, _digest(AdvanceEpochMutation.hashAdvanceEpoch(advance)), authority
        );
    }

    function callExecuteAdvanceEpoch(AdvanceEpochMutation.AdvanceEpoch memory advance) external {
        AdvanceEpochMutation.executeAdvanceEpoch(state, advance);
    }

    function test_Initialize_FillsTeamsInBalanceOrder() public {
        // setUp already registered two accounts, one per team.
        assertEq(state.accounts[alice].team, 0);
        assertEq(state.accounts[bob].team, 1);

        for (uint256 i = 0; i < TEAM_COUNT; i++) {
            uint256 pk = 0xF00D + i;
            _initAccount(pk, pk + 1, keccak256(abi.encode(vm.addr(pk))), ALL_PERMISSIONS);
        }

        // Two of the four new players fill teams 2 and 3, then the counts wrap.
        assertEq(state.teamPlayers[0], 2);
        assertEq(state.teamPlayers[1], 2);
        assertEq(state.teamPlayers[2], 1);
        assertEq(state.teamPlayers[3], 1);
    }

    function test_Initialize_StartsWithFullEnergy() public view {
        assertEq(state.accounts[alice].energy, ENERGY_PER_EPOCH);
    }

    function test_Initialize_RejectsMismatchedAccountId() public {
        InitializeMutation.Initialize memory init = InitializeMutation.Initialize({
            account: bytes32(uint256(1)),
            expiry: 0,
            rootKeyType: uint8(KeyType.Secp256k1),
            keyType: uint8(KeyType.Secp256k1),
            permissions: ALL_PERMISSIONS,
            rootPublicKey: abi.encode(vm.addr(0xBEEF)),
            publicKey: abi.encode(vm.addr(0xBEEF))
        });
        vm.expectRevert(InvalidAccount.selector);
        this.callInitialize(init, Signature({account: bytes32(uint256(1)), keyId: 0, rawSignature: ""}));
    }

    function test_Initialize_Twice() public {
        vm.expectRevert(AlreadyInitialized.selector);
        this.callInitAccount(alicePk, aliceSessionPk, alice, ALL_PERMISSIONS);
    }

    function test_Paint_WritesPixelAndScores() public {
        _paint(alice, aliceSessionPk, 10, 20, RED, 0);

        assertEq(_pixel(10, 20), RED);
        assertEq(state.teamPixels[0], 1);
        assertEq(state.accounts[alice].painted, 1);
        assertEq(state.accounts[alice].energy, ENERGY_PER_EPOCH - 1);
    }

    function test_Paint_MovesScoreBetweenTeams() public {
        _paint(alice, aliceSessionPk, 10, 20, RED, 0);
        _paint(bob, bobSessionPk, 10, 20, BLUE, 0);

        assertEq(_pixel(10, 20), BLUE);
        assertEq(state.teamPixels[0], 0);
        assertEq(state.teamPixels[1], 1);
    }

    function test_Paint_RejectsOtherTeamsColor() public {
        vm.expectRevert(WrongTeam.selector);
        this.callPaint(alice, aliceSessionPk, 1, 1, BLUE, 0);
    }

    function test_Paint_RejectsUnknownColor() public {
        vm.expectRevert(InvalidColor.selector);
        this.callPaint(alice, aliceSessionPk, 1, 1, 13, 0);
    }

    function test_Paint_RejectsOutOfBounds() public {
        vm.expectRevert(OutOfBounds.selector);
        this.callPaint(alice, aliceSessionPk, 128, 0, RED, 0);
    }

    function test_Paint_PacksNeighbouringPixelsIndependently() public {
        // Pixels 63 and 64 are the last and first slots of adjacent words.
        _paint(alice, aliceSessionPk, 63, 0, RED, 0);
        _paint(alice, aliceSessionPk, 64, 0, RED_DARK, 1);
        _paint(alice, aliceSessionPk, 127, 127, RED, 2);

        assertEq(_pixel(63, 0), RED);
        assertEq(_pixel(64, 0), RED_DARK);
        assertEq(_pixel(127, 127), RED);
        assertEq(_pixel(62, 0), 0);
        assertEq(_pixel(65, 0), 0);
    }

    /// The batch order the server enforces means every Shield in a tick runs
    /// before every Paint in that tick. Executed in that order, a pixel shielded
    /// in the same tick it is attacked keeps its color and burns a shield charge.
    function test_Shield_BeforePaint_AbsorbsTheHit() public {
        _paint(alice, aliceSessionPk, 5, 5, RED, 0);

        // One tick: alice shields, bob paints the same pixel.
        _shield(alice, aliceSessionPk, 5, 5, 1);
        _paint(bob, bobSessionPk, 5, 5, BLUE, 0);

        assertEq(_pixel(5, 5), RED, "shield should have absorbed the paint");
        assertEq(state.shields[pixelIndex(5, 5)], 0, "shield charge should be spent");
        assertEq(state.teamPixels[0], 1);
        assertEq(state.teamPixels[1], 0);

        // The next tick has no shield left, so the same paint lands.
        _paint(bob, bobSessionPk, 5, 5, BLUE, 1);
        assertEq(_pixel(5, 5), BLUE);
    }

    function test_Shield_ChargesAttackerEnergyEvenWhenAbsorbed() public {
        _paint(alice, aliceSessionPk, 5, 5, RED, 0);
        _shield(alice, aliceSessionPk, 5, 5, 1);
        _paint(bob, bobSessionPk, 5, 5, BLUE, 0);

        assertEq(state.accounts[bob].energy, ENERGY_PER_EPOCH - 1);
        assertEq(state.accounts[bob].painted, 0);
    }

    function test_Shield_StacksToCap() public {
        _paint(alice, aliceSessionPk, 5, 5, RED, 0);
        _shield(alice, aliceSessionPk, 5, 5, 1);
        _shield(alice, aliceSessionPk, 5, 5, 2);
        _shield(alice, aliceSessionPk, 5, 5, 3);
        _shield(alice, aliceSessionPk, 5, 5, 4);

        assertEq(state.shields[pixelIndex(5, 5)], MAX_SHIELD_STACK);
    }

    function test_Shield_RejectsOtherTeamsPixel() public {
        _paint(bob, bobSessionPk, 5, 5, BLUE, 0);

        vm.expectRevert(NotShieldable.selector);
        this.callShield(alice, aliceSessionPk, 5, 5, 0);
    }

    function test_Shield_RejectsBareCanvas() public {
        vm.expectRevert(NotShieldable.selector);
        this.callShield(alice, aliceSessionPk, 7, 7, 0);
    }

    /// Bombs run after paints in a tick, so a bomb buries paints from the same
    /// tick — except where a shield (which ran first) eats it.
    function test_Bomb_AfterPaint_OverwritesTheTick() public {
        _paint(alice, aliceSessionPk, 40, 40, RED, 0);
        _shield(alice, aliceSessionPk, 40, 40, 1);

        // One tick: alice paints a neighbour, then bob bombs the 3x3.
        _paint(alice, aliceSessionPk, 41, 40, RED, 2);
        _bomb(bob, bobSessionPk, 40, 40, BLUE, 0);

        assertEq(_pixel(41, 40), BLUE, "bomb should bury the paint from the same tick");
        assertEq(_pixel(40, 40), RED, "shielded center should survive the bomb");
        assertEq(_pixel(39, 39), BLUE);
        assertEq(state.accounts[bob].energy, ENERGY_PER_EPOCH - 10);
    }

    function test_Bomb_ClipsAtCanvasEdge() public {
        _bomb(alice, aliceSessionPk, 0, 0, RED, 0);

        assertEq(_pixel(0, 0), RED);
        assertEq(_pixel(1, 1), RED);
        assertEq(state.teamPixels[0], 4, "a corner bomb covers 2x2");
    }

    function test_Energy_RunsOutWithinAnEpochAndRefillsAfter() public {
        for (uint256 i = 0; i < ENERGY_PER_EPOCH; i++) {
            _paint(alice, aliceSessionPk, uint16(i), 0, RED, i);
        }
        assertEq(state.accounts[alice].energy, 0);

        vm.expectRevert(OutOfEnergy.selector);
        this.callPaint(alice, aliceSessionPk, 100, 0, RED, ENERGY_PER_EPOCH);

        _advanceEpoch(1);

        _paint(alice, aliceSessionPk, 100, 0, RED, ENERGY_PER_EPOCH);
        assertEq(state.accounts[alice].energy, ENERGY_PER_EPOCH - 1);
    }

    /// Epoch advances ride their own nonce lane so they never serialize behind
    /// the paints in this test's default lane.
    function _advanceEpoch(uint64 epoch) internal {
        uint256 nonce = (uint256(11) << 64) | (epoch - 1);
        AdvanceEpochMutation.AdvanceEpoch memory advance =
            AdvanceEpochMutation.AdvanceEpoch({epoch: epoch, nonce: nonce, deadline: type(uint256).max});
        bytes32 structHash = AdvanceEpochMutation.hashAdvanceEpoch(advance);
        Signature memory signature = _signature(alice, 1, aliceSessionPk, structHash);
        AdvanceEpochMutation.verifyAdvanceEpochSignature(state, advance, signature, _digest(structHash), alice);
        AdvanceEpochMutation.executeAdvanceEpoch(state, advance);
    }

    function test_AdvanceEpoch_RejectsNonAuthority() public {
        AdvanceEpochMutation.AdvanceEpoch memory advance =
            AdvanceEpochMutation.AdvanceEpoch({epoch: 1, nonce: 0, deadline: type(uint256).max});
        bytes32 structHash = AdvanceEpochMutation.hashAdvanceEpoch(advance);
        Signature memory signature = _signature(bob, 1, bobSessionPk, structHash);

        // Bob's root key holds every permission bit, so only the authority check
        // stops him from refilling his own energy on demand.
        vm.expectRevert(Unauthorized.selector);
        this.callVerifyAdvanceEpoch(advance, signature, alice);
    }

    function test_AdvanceEpoch_RejectsSkippedEpoch() public {
        AdvanceEpochMutation.AdvanceEpoch memory advance =
            AdvanceEpochMutation.AdvanceEpoch({epoch: 2, nonce: 0, deadline: type(uint256).max});
        vm.expectRevert(StaleEpoch.selector);
        this.callExecuteAdvanceEpoch(advance);
    }

    function test_Permissions_SessionKeyWithoutBombCannotBomb() public {
        uint256 pk = 0xCAFE;
        bytes32 account = keccak256(abi.encode(vm.addr(pk)));
        _initAccount(pk, pk + 1, account, PERM_PAINT);

        _paint(account, pk + 1, 3, 3, uint8(1 + 3 * state.accounts[account].team), 0);

        vm.expectRevert(Unauthorized.selector);
        this.callBomb(account, pk + 1, 3, 3, uint8(1 + 3 * state.accounts[account].team), 1);
    }

    function test_Authorize_CannotEscalateBeyondSigningKey() public {
        uint256 pk = 0xD00D;
        bytes32 account = keccak256(abi.encode(vm.addr(pk)));
        _initAccount(pk, pk + 1, account, PERM_PAINT | PERM_AUTHORIZE);

        AuthorizeMutation.Authorize memory authorize = AuthorizeMutation.Authorize({
            account: account,
            expiry: 0,
            keyType: uint8(KeyType.Secp256k1),
            permissions: ALL_PERMISSIONS,
            publicKey: abi.encode(vm.addr(pk + 2)),
            nonce: 0,
            deadline: type(uint256).max
        });
        bytes32 structHash = AuthorizeMutation.hashAuthorize(authorize);
        Signature memory signature = _signature(account, 1, pk + 1, structHash);
        AuthorizeMutation.verifyAuthorizeSignature(state, authorize, signature, _digest(structHash));
        AuthorizeMutation.executeAuthorize(state, authorize, signature);

        assertEq(state.accounts[account].keys[2].permissions, PERM_PAINT | PERM_AUTHORIZE);
    }

    function test_Revoke_RetiresKey() public {
        RevokeMutation.Revoke memory revoke =
            RevokeMutation.Revoke({account: alice, keyId: 1, nonce: 0, deadline: type(uint256).max});
        bytes32 structHash = RevokeMutation.hashRevoke(revoke);
        Signature memory signature = _signature(alice, 0, alicePk, structHash);
        RevokeMutation.verifyRevokeSignature(state, revoke, signature, _digest(structHash));
        RevokeMutation.executeRevoke(state, revoke, signature);

        vm.expectRevert(KeyNotFound.selector);
        this.callPaint(alice, aliceSessionPk, 1, 1, RED, 1);
    }

    function test_Nonce_ParallelKeysDoNotSerialize() public {
        uint256 laneA = uint256(7) << 64;
        uint256 laneB = uint256(9) << 64;

        _paint(alice, aliceSessionPk, 1, 1, RED, laneA);
        _paint(alice, aliceSessionPk, 2, 1, RED, laneB);
        _paint(alice, aliceSessionPk, 3, 1, RED, laneA + 1);

        assertEq(state.accounts[alice].nonces[7], 2);
        assertEq(state.accounts[alice].nonces[9], 1);
    }

    function test_Nonce_RejectsReplay() public {
        _paint(alice, aliceSessionPk, 1, 1, RED, 0);
        vm.expectRevert(InvalidNonce.selector);
        this.callPaint(alice, aliceSessionPk, 2, 1, RED, 0);
    }

    function test_Signature_RejectsExpiredDeadline() public {
        vm.warp(1000);
        PaintMutation.Paint memory paint = PaintMutation.Paint({x: 1, y: 1, color: RED, nonce: 0, deadline: 999});
        bytes32 structHash = PaintMutation.hashPaint(paint);
        Signature memory signature = _signature(alice, 1, aliceSessionPk, structHash);

        vm.expectRevert(SignatureExpired.selector);
        this.callVerifyPaint(paint, signature);
    }

    function test_Signature_RejectsExpiredKey() public {
        uint256 pk = 0xE1E1;
        bytes32 account = keccak256(abi.encode(vm.addr(pk)));
        InitializeMutation.Initialize memory init = InitializeMutation.Initialize({
            account: account,
            expiry: 500,
            rootKeyType: uint8(KeyType.Secp256k1),
            keyType: uint8(KeyType.Secp256k1),
            permissions: ALL_PERMISSIONS,
            rootPublicKey: abi.encode(vm.addr(pk)),
            publicKey: abi.encode(vm.addr(pk + 1))
        });
        InitializeMutation.executeInitialize(state, init, Signature({account: account, keyId: 0, rawSignature: ""}));

        vm.warp(501);
        vm.expectRevert(KeyExpired.selector);
        this.callPaint(account, pk + 1, 1, 1, RED, 0);
    }

    /// RIP-7212 lives at `address(0x100)` on Monad, but plain upstream Foundry
    /// has no such precompile, so the P-256 case below can only run under the
    /// Monad build of Foundry.
    function _hasP256Precompile() internal view returns (bool) {
        (bool ok, bytes memory ret) = address(0x100).staticcall(abi.encode(0, 0, 0, 0, 0));
        return ok && ret.length >= 32;
    }

    /// The browser signs with a P-256 session key, so cover that path against the
    /// precompile the runtime relies on.
    function test_Paint_WithP256SessionKey() public {
        vm.skip(!_hasP256Precompile(), "requires the RIP-7212 precompile (Monad Foundry)");

        uint256 pk = 0xC0FFEE;
        bytes32 account = keccak256(abi.encode(vm.addr(0xF1F1)));
        (uint256 x, uint256 y) = vm.publicKeyP256(pk);

        InitializeMutation.Initialize memory init = InitializeMutation.Initialize({
            account: account,
            expiry: 0,
            rootKeyType: uint8(KeyType.Secp256k1),
            keyType: uint8(KeyType.P256),
            permissions: ALL_PERMISSIONS,
            rootPublicKey: abi.encode(vm.addr(0xF1F1)),
            publicKey: abi.encodePacked(uint8(0x04), x, y)
        });
        InitializeMutation.executeInitialize(state, init, Signature({account: account, keyId: 0, rawSignature: ""}));

        uint8 color = uint8(1 + 3 * state.accounts[account].team);
        PaintMutation.Paint memory paint =
            PaintMutation.Paint({x: 9, y: 9, color: color, nonce: 0, deadline: type(uint256).max});
        bytes32 structHash = PaintMutation.hashPaint(paint);
        bytes32 digest = _digest(structHash);
        (bytes32 r, bytes32 s) = vm.signP256(pk, sha256(abi.encodePacked(digest)));
        Signature memory signature =
            Signature({account: account, keyId: 1, rawSignature: abi.encode(uint256(r), uint256(s))});

        PaintMutation.verifyPaintSignature(state, paint, signature, digest);
        PaintMutation.executePaint(state, paint, signature);

        assertEq(_pixel(9, 9), color);
    }
}
