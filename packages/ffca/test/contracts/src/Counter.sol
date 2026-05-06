// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EIP712_DOMAIN_TYPEHASH} from "ffca/FFCA.sol";
import {KeyType, verifySignature} from "ffca/Account.sol";

struct Signature {
    uint8 keyType;
    bytes rawSignature;
}

struct Bundle {
    uint8[] mutations;
    bytes[] mutationData;
    Signature[] signatures;
}

struct State {
    uint256 total;
    uint256 nonce;
}

/// Single-signer secp256k1 fixture for ffca's submit path. `add` mutations
/// must be EIP-712-signed by the address set at construction time. ffca's
/// local `apply` mirrors the addition; the contract enforces the signature
/// and the nonce.
contract Counter {
    bytes32 constant ADD_TYPEHASH = keccak256("add(uint256 amount,uint256 nonce)");

    State public state;
    address public immutable signer;
    bytes32 public immutable domainSeparator;

    uint8 constant ADD = 0;

    error InvalidNonce();
    error UnknownTag();

    constructor(address _signer) {
        signer = _signer;
        domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes("Counter")), keccak256(bytes("1")), block.chainid, address(this)
            )
        );
    }

    function execute(Bundle[] calldata bundles) external {
        for (uint256 b; b < bundles.length; b++) {
            Bundle calldata bundle = bundles[b];
            for (uint256 i; i < bundle.mutations.length; i++) {
                _apply(bundle.mutations[i], bundle.mutationData[i], bundle.signatures[i]);
            }
        }
    }

    function _apply(uint8 tag, bytes calldata data, Signature calldata sig) internal {
        if (tag != ADD) revert UnknownTag();

        (uint256 amount, uint256 nonce) = abi.decode(data, (uint256, uint256));
        if (nonce != state.nonce) revert InvalidNonce();

        bytes32 structHash = keccak256(abi.encode(ADD_TYPEHASH, amount, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        verifySignature(KeyType(sig.keyType), digest, abi.encode(signer), sig.rawSignature);

        state.total += amount;
        state.nonce++;
    }
}
