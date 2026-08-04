// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {
    ENERGY_PER_EPOCH,
    PERM_ADVANCE_EPOCH,
    PERM_AUTHORIZE,
    PERM_BOMB,
    PERM_PAINT,
    PERM_REVOKE,
    PERM_SHIELD,
    PixelWar,
    Signature,
    State,
    pixelIndex,
    readPixel
} from "src/PixelWar.sol";
import {AdvanceEpochMutation} from "src/AdvanceEpoch.sol";
import {BombMutation} from "src/Bomb.sol";
import {InitializeMutation} from "src/Initialize.sol";
import {PaintMutation} from "src/Paint.sol";
import {ShieldMutation} from "src/Shield.sol";

import {EIP712_DOMAIN_TYPEHASH, KeyType, Typewriter} from "typewriter/Typewriter.sol";

uint16 constant ALL_PERMISSIONS =
    PERM_AUTHORIZE | PERM_REVOKE | PERM_PAINT | PERM_SHIELD | PERM_BOMB | PERM_ADVANCE_EPOCH;

/// `PixelWar` deliberately ships no public getters — the runtime reads storage
/// slots directly. Tests need reads, so this subclass exposes the few views the
/// assertions want without touching the deployed contract's surface.
contract PixelWarHarness is PixelWar {
    constructor(address scheduler) PixelWar(scheduler) {}

    function pixelAt(uint16 x, uint16 y) external view returns (uint8) {
        return readPixel(state, pixelIndex(x, y));
    }

    function shieldAt(uint16 x, uint16 y) external view returns (uint8) {
        return state.shields[pixelIndex(x, y)];
    }

    function epoch() external view returns (uint64) {
        return state.epoch;
    }

    function teamOf(bytes32 account) external view returns (uint8) {
        return state.accounts[account].team;
    }

    function energyOf(bytes32 account) external view returns (uint32) {
        return state.accounts[account].epoch == state.epoch ? state.accounts[account].energy : ENERGY_PER_EPOCH;
    }

    function teamPixels(uint8 team) external view returns (uint32) {
        return state.teamPixels[team];
    }
}

contract BatchTest is Test {
    PixelWarHarness internal app;
    bytes32 internal DOMAIN_SEPARATOR;

    uint256 internal schedulerPk = 0x5CDE;
    uint256 internal alicePk = 0xA11CE;
    uint256 internal bobPk = 0xB0B;

    bytes32 internal authority;
    bytes32 internal alice;
    bytes32 internal bob;

    uint8 internal constant RED = 1;
    uint8 internal constant BLUE = 4;

    function setUp() public {
        app = new PixelWarHarness(vm.addr(schedulerPk));
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Typewriter")),
                keccak256(bytes("1")),
                block.chainid,
                address(app)
            )
        );
        authority = keccak256(abi.encode(vm.addr(schedulerPk)));
        alice = keccak256(abi.encode(vm.addr(alicePk)));
        bob = keccak256(abi.encode(vm.addr(bobPk)));

        // The authority registers first, so players start on teams 1 and 2.
        _submit(_initializeMutation(schedulerPk, authority));
        _submit(_initializeMutation(alicePk, alice));
        _submit(_initializeMutation(bobPk, bob));
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _signatureData(bytes32 account, uint64 keyId, uint256 pk, bytes32 structHash)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(structHash));
        return abi.encode(Signature({account: account, keyId: keyId, rawSignature: abi.encode(v, r, s)}));
    }

    struct Item {
        uint8 mutation;
        bytes mutationData;
        bytes signatureData;
    }

    function _initializeMutation(uint256 pk, bytes32 account) internal view returns (Item memory) {
        InitializeMutation.Initialize memory init = InitializeMutation.Initialize({
            account: account,
            expiry: 0,
            rootKeyType: uint8(KeyType.Secp256k1),
            keyType: uint8(KeyType.Secp256k1),
            permissions: ALL_PERMISSIONS,
            rootPublicKey: abi.encode(vm.addr(pk)),
            publicKey: abi.encode(vm.addr(pk))
        });
        return Item({
            mutation: uint8(PixelWar.Mutation.Initialize),
            mutationData: abi.encode(init),
            signatureData: abi.encode(Signature({account: account, keyId: 0, rawSignature: ""}))
        });
    }

    function _paintMutation(bytes32 account, uint256 pk, uint16 x, uint16 y, uint8 color, uint256 nonce)
        internal
        view
        returns (Item memory)
    {
        PaintMutation.Paint memory paint =
            PaintMutation.Paint({x: x, y: y, color: color, nonce: nonce, deadline: type(uint256).max});
        return Item({
            mutation: uint8(PixelWar.Mutation.Paint),
            mutationData: abi.encode(paint),
            signatureData: _signatureData(account, 1, pk, PaintMutation.hashPaint(paint))
        });
    }

    function _shieldMutation(bytes32 account, uint256 pk, uint16 x, uint16 y, uint256 nonce)
        internal
        view
        returns (Item memory)
    {
        ShieldMutation.Shield memory shield =
            ShieldMutation.Shield({x: x, y: y, nonce: nonce, deadline: type(uint256).max});
        return Item({
            mutation: uint8(PixelWar.Mutation.Shield),
            mutationData: abi.encode(shield),
            signatureData: _signatureData(account, 1, pk, ShieldMutation.hashShield(shield))
        });
    }

    function _bombMutation(bytes32 account, uint256 pk, uint16 x, uint16 y, uint8 color, uint256 nonce)
        internal
        view
        returns (Item memory)
    {
        BombMutation.Bomb memory bomb =
            BombMutation.Bomb({x: x, y: y, color: color, nonce: nonce, deadline: type(uint256).max});
        return Item({
            mutation: uint8(PixelWar.Mutation.Bomb),
            mutationData: abi.encode(bomb),
            signatureData: _signatureData(account, 1, pk, BombMutation.hashBomb(bomb))
        });
    }

    function _advanceEpochMutation(uint64 epoch, uint256 nonce) internal view returns (Item memory) {
        AdvanceEpochMutation.AdvanceEpoch memory advance =
            AdvanceEpochMutation.AdvanceEpoch({epoch: epoch, nonce: nonce, deadline: type(uint256).max});
        return Item({
            mutation: uint8(PixelWar.Mutation.AdvanceEpoch),
            mutationData: abi.encode(advance),
            signatureData: _signatureData(authority, 1, schedulerPk, AdvanceEpochMutation.hashAdvanceEpoch(advance))
        });
    }

    function _batch(Item[] memory items) internal pure returns (Typewriter.Batch[] memory batches) {
        batches = new Typewriter.Batch[](1);
        batches[0].mutations = new uint8[](items.length);
        batches[0].mutationData = new bytes[](items.length);
        batches[0].signatureData = new bytes[](items.length);
        for (uint256 i = 0; i < items.length; i++) {
            batches[0].mutations[i] = items[i].mutation;
            batches[0].mutationData[i] = items[i].mutationData;
            batches[0].signatureData[i] = items[i].signatureData;
        }
    }

    function _submit(Item memory item) internal {
        Item[] memory items = new Item[](1);
        items[0] = item;
        _submitAll(items);
    }

    function _submitAll(Item[] memory items) internal {
        vm.prank(vm.addr(schedulerPk));
        app.execute(_batch(items), new uint256[](0));
    }

    function test_Execute_OnlyScheduler() public {
        Item[] memory items = new Item[](1);
        items[0] = _paintMutation(alice, alicePk, 1, 1, _colorFor(alice), 0);

        vm.expectRevert(abi.encodeWithSelector(Typewriter.UnauthorizedExecute.selector, address(this)));
        app.execute(_batch(items), new uint256[](0));
    }

    function _colorFor(bytes32 account) internal view returns (uint8) {
        return uint8(1 + 3 * app.teamOf(account));
    }

    /// The server's `batchOrder` puts every Shield ahead of every Paint and every
    /// Paint ahead of every Bomb. This is that batch, submitted in one
    /// transaction, and it shows the rule resolving three ways at once.
    function test_Batch_ShieldBeatsPaint_PaintLosesToBomb() public {
        _submit(_paintMutation(alice, alicePk, 5, 5, _colorFor(alice), 0));

        // One tick: alice shields (5,5) as bob paints it, and alice paints (40,5)
        // as bob bombs it. The bomb's 3x3 stays clear of the shielded pixel.
        Item[] memory tick = new Item[](4);
        tick[0] = _shieldMutation(alice, alicePk, 5, 5, 1);
        tick[1] = _paintMutation(bob, bobPk, 5, 5, _colorFor(bob), 0);
        tick[2] = _paintMutation(alice, alicePk, 40, 5, _colorFor(alice), 2);
        tick[3] = _bombMutation(bob, bobPk, 40, 5, _colorFor(bob), 1);
        _submitAll(tick);

        assertEq(app.pixelAt(5, 5), _colorFor(alice), "shield ran first and absorbed the paint");
        assertEq(app.shieldAt(5, 5), 0, "the shield charge paid for it");
        assertEq(app.pixelAt(40, 5), _colorFor(bob), "the bomb ran last and buried the paint");
    }

    function test_Batch_AdvanceEpochRefillsWithinTheSameBatch() public {
        Item[] memory drain = new Item[](ENERGY_PER_EPOCH);
        for (uint256 i = 0; i < ENERGY_PER_EPOCH; i++) {
            drain[i] = _paintMutation(alice, alicePk, uint16(i), 10, _colorFor(alice), i);
        }
        _submitAll(drain);
        assertEq(app.energyOf(alice), 0);

        // AdvanceEpoch sorts ahead of Paint, so a paint in the same tick as the
        // epoch rollover already sees the refilled energy.
        Item[] memory tick = new Item[](2);
        tick[0] = _advanceEpochMutation(1, 0);
        tick[1] = _paintMutation(alice, alicePk, 50, 10, _colorFor(alice), ENERGY_PER_EPOCH);
        _submitAll(tick);

        assertEq(app.epoch(), 1);
        assertEq(app.pixelAt(50, 10), _colorFor(alice));
        assertEq(app.energyOf(alice), ENERGY_PER_EPOCH - 1);
    }

    function test_ForceInclusion_LandsWithoutTheServer() public {
        uint8 color = _colorFor(alice);
        PaintMutation.Paint memory paint =
            PaintMutation.Paint({x: 70, y: 70, color: color, nonce: 0, deadline: type(uint256).max});

        // A censored player queues the mutation onchain themselves.
        uint256 index = app.enqueue(
            uint8(PixelWar.Mutation.Paint),
            abi.encode(paint),
            _signatureData(alice, 1, alicePk, PaintMutation.hashPaint(paint))
        );

        vm.expectRevert(abi.encodeWithSelector(Typewriter.ForceInclusionTooEarly.selector, 658));
        app.forceExecute(index);

        vm.roll(block.number + 658);
        app.forceExecute(index);

        assertEq(app.pixelAt(70, 70), color, "force-included paint landed with no scheduler involvement");
    }

    function test_TeamPixels_TracksCanvasShare() public {
        _submit(_paintMutation(alice, alicePk, 1, 1, _colorFor(alice), 0));
        _submit(_paintMutation(alice, alicePk, 2, 1, _colorFor(alice), 1));
        _submit(_paintMutation(bob, bobPk, 1, 1, _colorFor(bob), 0));

        assertEq(app.teamPixels(app.teamOf(alice)), 1);
        assertEq(app.teamPixels(app.teamOf(bob)), 1);
    }
}
