// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The storage shape of `apps/order-book`, including the `accounts`
/// root that it inherits from `Typewriter.sol`. Used by the benchmark.
contract OrderBookFixture {
    enum KeyType {
        Secp256k1,
        P256,
        WebAuthn
    }

    struct Credential {
        uint40 expiration;
        KeyType keyType;
        uint256 permissions;
        bytes publicKey;
    }

    struct TypewriterAccount {
        mapping(uint192 => uint64) nonces;
        Credential[] credentials;
        uint64 activeCredentials;
    }

    struct State {
        mapping(bytes32 => Account) accounts;
        mapping(uint64 => Instrument) instruments;
    }

    struct Account {
        mapping(address => uint256) balances;
        Order[] orders;
    }

    struct Order {
        uint64 quantity;
        uint64 instrumentId;
        uint64 price;
        uint32 tickVolume;
        uint8 side;
    }

    struct Instrument {
        address base;
        address quote;
        uint8 baseLotExp;
        uint8 quoteLotExp;
        uint64 bestBid;
        uint64 bestAsk;
        mapping(uint64 => Tick) bids;
        mapping(uint64 => Tick) asks;
    }

    struct Tick {
        uint64 quantity;
        uint64 remainingQuantity;
        uint32 volume;
        uint64 prev;
        uint64 next;
    }

    mapping(bytes32 => TypewriterAccount) internal accounts;
    State internal state;
}
