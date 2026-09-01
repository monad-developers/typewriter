// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

enum KeyType {
    P256,
    WebAuthnP256,
    Secp256k1
}

struct Credential {
    uint40 expiration;
    KeyType keyType;
    uint256 permissions;
    bytes publicKey;
}

struct Account {
    mapping(uint192 => uint64) nonces;
    Credential[] credentials;
    uint64 activeCredentials;
}

struct Authorization {
    bytes32 accountID;
    uint64 credentialID;
    uint256 nonce;
    uint256 expiration;
    bytes signature;
}

struct CreateAccount {
    KeyType keyType;
    bytes publicKey;
}

struct AddCredential {
    uint40 expiration;
    KeyType keyType;
    uint256 permissions;
    bytes publicKey;
}

struct RemoveCredential {
    uint64 credentialID;
}

bytes32 constant EIP712_DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
bytes32 constant AUTHORIZATION_TYPEHASH = keccak256(
    "Authorization(bytes32 accountID,uint64 credentialID,uint256 nonce,uint256 expiration,uint8 mutation,bytes mutationData)"
);
string constant TYPEWRITER_DOMAIN_NAME = "Typewriter";
string constant TYPEWRITER_DOMAIN_VERSION = "1";

address constant P256_VERIFIER = address(0x100);

uint8 constant CREATE_ACCOUNT_MUTATION = 253;
uint8 constant ADD_CREDENTIAL_MUTATION = 254;
uint8 constant REMOVE_CREDENTIAL_MUTATION = 255;

error UnknownMutation(uint8 mutation);
error InvalidSignature(KeyType keyType);
error AccountAlreadyExists(bytes32 accountID);
error AccountNotFound(bytes32 accountID);
error CredentialNotFound(bytes32 accountID, uint64 credentialID);
error EmptyPublicKey();
error InvalidCreateAuthorization();
error AuthorizationExpired(uint256 expiration);
error CredentialExpired(uint40 expiration);
error PermissionDenied(bytes32 accountID, uint64 credentialID, uint8 mutation);
error InvalidNonce(bytes32 accountID, uint192 lane, uint64 expected, uint64 received);
error NonceOverflow(bytes32 accountID, uint192 lane);
error LastCredential(bytes32 accountID);

function verifySignature(KeyType keyType, bytes32 digest, bytes memory publicKey, bytes memory signature) view {
    if (keyType == KeyType.Secp256k1) {
        verifySecp256k1(digest, publicKey, signature);
    } else if (keyType == KeyType.P256) {
        verifyP256(digest, publicKey, signature);
    } else {
        verifyWebAuthnP256(digest, publicKey, signature);
    }
}

function verifySecp256k1(bytes32 digest, bytes memory publicKey, bytes memory signature) pure {
    address expected = abi.decode(publicKey, (address));
    (uint8 v, bytes32 r, bytes32 s) = abi.decode(signature, (uint8, bytes32, bytes32));
    address recovered = ecrecover(digest, v, r, s);
    if (recovered == address(0) || recovered != expected) revert InvalidSignature(KeyType.Secp256k1);
}

function verifyP256(bytes32 digest, bytes memory publicKey, bytes memory signature) view {
    (uint256 x, uint256 y) = decodeP256PublicKey(publicKey);
    (uint256 r, uint256 s) = abi.decode(signature, (uint256, uint256));
    (bool ok, bytes memory ret) =
        P256_VERIFIER.staticcall(abi.encode(uint256(sha256(abi.encodePacked(digest))), r, s, x, y));
    if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) != 1) revert InvalidSignature(KeyType.P256);
}

function verifyWebAuthnP256(bytes32 digest, bytes memory publicKey, bytes memory signature) view {
    (uint256 x, uint256 y) = decodeP256PublicKey(publicKey);
    (bytes memory authData, bytes memory clientDataJSON, uint256 challengeOffset, uint256 r, uint256 s) =
        abi.decode(signature, (bytes, bytes, uint256, uint256, uint256));

    verifyChallenge(clientDataJSON, challengeOffset, digest);

    bytes32 message = sha256(abi.encodePacked(authData, sha256(clientDataJSON)));
    (bool ok, bytes memory ret) = P256_VERIFIER.staticcall(abi.encode(uint256(message), r, s, x, y));
    if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) != 1) revert InvalidSignature(KeyType.WebAuthnP256);
}

function decodeP256PublicKey(bytes memory publicKey) pure returns (uint256 x, uint256 y) {
    if (publicKey.length == 65) {
        assembly {
            x := mload(add(publicKey, 33))
            y := mload(add(publicKey, 65))
        }
    } else {
        (x, y) = abi.decode(publicKey, (uint256, uint256));
    }
}

function verifyChallenge(bytes memory clientDataJSON, uint256 offset, bytes32 digest) pure {
    bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    if (offset + 43 > clientDataJSON.length) revert InvalidSignature(KeyType.WebAuthnP256);
    for (uint256 i; i < 32;) {
        uint256 a = uint8(digest[i++]);
        uint256 b = i < 32 ? uint8(digest[i++]) : 0;
        uint256 c = i < 32 ? uint8(digest[i++]) : 0;
        uint256 triple = (a << 16) | (b << 8) | c;
        if (clientDataJSON[offset++] != table[(triple >> 18) & 0x3F]) revert InvalidSignature(KeyType.WebAuthnP256);
        if (clientDataJSON[offset++] != table[(triple >> 12) & 0x3F]) revert InvalidSignature(KeyType.WebAuthnP256);
        if (clientDataJSON[offset++] != table[(triple >> 6) & 0x3F]) revert InvalidSignature(KeyType.WebAuthnP256);
        if (i < 32) {
            if (clientDataJSON[offset++] != table[triple & 0x3F]) revert InvalidSignature(KeyType.WebAuthnP256);
        }
    }
}

abstract contract Typewriter {
    struct Batch {
        uint8[] mutations;
        bytes[] mutationData;
        bytes[] authorizationData;
    }

    struct QueuedMutation {
        uint8 mutation;
        bytes mutationData;
        bytes authorizationData;
        uint256 enqueuedBlock;
    }

    event ForceInclusionQueued(
        uint256 index, uint8 mutation, bytes mutationData, bytes authorizationData, uint256 enqueuedBlock
    );

    error UnauthorizedExecute(address caller);
    error ForceInclusionTooEarly(uint256 remainingDelay);
    error ForceInclusionAlreadyExecuted(uint256 index);
    error LengthMismatch();

    address internal immutable SCHEDULER;
    bytes32 internal immutable DOMAIN_SEPARATOR;
    uint256 internal immutable FORCE_INCLUSION_DELAY;

    mapping(bytes32 => Account) internal accounts;
    QueuedMutation[] internal queue;
    uint256 public executionIndex;

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(TYPEWRITER_DOMAIN_NAME)),
                keccak256(bytes(TYPEWRITER_DOMAIN_VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID) internal virtual;

    function execute(Batch[] calldata batches, uint256[] calldata forceExecuteIndexes) external {
        if (msg.sender != SCHEDULER) revert UnauthorizedExecute(msg.sender);

        for (uint256 b; b < batches.length; b++) {
            Batch calldata batch = batches[b];
            if (
                batch.mutations.length != batch.mutationData.length
                    || batch.mutations.length != batch.authorizationData.length
            ) {
                revert LengthMismatch();
            }
            for (uint256 i; i < batch.mutations.length; i++) {
                _execute(batch.mutations[i], batch.mutationData[i], batch.authorizationData[i]);
                executionIndex++;
            }
        }

        for (uint256 i; i < forceExecuteIndexes.length; i++) {
            uint256 index = forceExecuteIndexes[i];
            QueuedMutation storage queued = queue[index];

            if (queued.enqueuedBlock == 0) revert ForceInclusionAlreadyExecuted(index);

            _execute(queued.mutation, queued.mutationData, queued.authorizationData);
            executionIndex++;

            delete queue[index];
        }
    }

    function enqueue(uint8 mutation, bytes calldata mutationData, bytes calldata authorizationData)
        external
        returns (uint256)
    {
        uint256 index = queue.length;
        uint256 enqueuedBlock = block.number;
        queue.push(
            QueuedMutation({
                mutation: mutation,
                mutationData: mutationData,
                authorizationData: authorizationData,
                enqueuedBlock: enqueuedBlock
            })
        );
        emit ForceInclusionQueued(index, mutation, mutationData, authorizationData, enqueuedBlock);
        return index;
    }

    function forceExecute(uint256 index) external {
        QueuedMutation storage queued = queue[index];

        if (block.number < queued.enqueuedBlock + FORCE_INCLUSION_DELAY) {
            revert ForceInclusionTooEarly((queued.enqueuedBlock + FORCE_INCLUSION_DELAY) - block.number);
        }
        if (queued.enqueuedBlock == 0) revert ForceInclusionAlreadyExecuted(index);

        _execute(queued.mutation, queued.mutationData, queued.authorizationData);
        executionIndex++;

        delete queue[index];
    }

    function _execute(uint8 mutation, bytes memory mutationData, bytes memory authorizationData) internal {
        Authorization memory authorization = abi.decode(authorizationData, (Authorization));
        Account storage account;
        CreateAccount memory createAccount;

        if (mutation == CREATE_ACCOUNT_MUTATION) {
            if (
                authorization.credentialID != 0 || authorization.nonce != 0 || authorization.expiration != 0
                    || authorization.signature.length == 0
            ) {
                revert InvalidCreateAuthorization();
            }

            createAccount = abi.decode(mutationData, (CreateAccount));
            if (createAccount.publicKey.length == 0) revert EmptyPublicKey();

            bytes32 accountID = keccak256(abi.encode(createAccount.keyType, createAccount.publicKey));
            if (authorization.accountID != accountID) revert InvalidCreateAuthorization();

            account = accounts[accountID];
            if (account.credentials.length != 0) revert AccountAlreadyExists(accountID);

            bytes32 digest = _authorizationDigest(authorization, CREATE_ACCOUNT_MUTATION, mutationData);
            verifySignature(createAccount.keyType, digest, createAccount.publicKey, authorization.signature);
        } else {
            account = accounts[authorization.accountID];
            if (account.credentials.length == 0) revert AccountNotFound(authorization.accountID);
            if (authorization.credentialID >= account.credentials.length) {
                revert CredentialNotFound(authorization.accountID, authorization.credentialID);
            }

            Credential storage credential = account.credentials[authorization.credentialID];
            if (credential.publicKey.length == 0) {
                revert CredentialNotFound(authorization.accountID, authorization.credentialID);
            }
            if (authorization.expiration != 0 && authorization.expiration < block.timestamp) {
                revert AuthorizationExpired(authorization.expiration);
            }
            if (credential.expiration != 0 && credential.expiration < block.timestamp) {
                revert CredentialExpired(credential.expiration);
            }
            if (credential.permissions & (uint256(1) << mutation) == 0) {
                revert PermissionDenied(authorization.accountID, authorization.credentialID, mutation);
            }

            uint192 nonceLane = uint192(authorization.nonce >> 64);
            uint64 nonceSequence = uint64(authorization.nonce);
            uint64 expectedSequence = account.nonces[nonceLane];
            if (nonceSequence == type(uint64).max) revert NonceOverflow(authorization.accountID, nonceLane);
            if (nonceSequence != expectedSequence) {
                revert InvalidNonce(authorization.accountID, nonceLane, expectedSequence, nonceSequence);
            }

            bytes32 digest = _authorizationDigest(authorization, mutation, mutationData);
            verifySignature(credential.keyType, digest, credential.publicKey, authorization.signature);
            account.nonces[nonceLane] = nonceSequence + 1;
        }

        if (mutation == CREATE_ACCOUNT_MUTATION) {
            account.credentials
                .push(
                    Credential({
                        expiration: 0,
                        keyType: createAccount.keyType,
                        permissions: type(uint256).max,
                        publicKey: createAccount.publicKey
                    })
                );
            account.activeCredentials = 1;
        } else if (mutation == ADD_CREDENTIAL_MUTATION) {
            AddCredential memory addCredential = abi.decode(mutationData, (AddCredential));
            if (addCredential.publicKey.length == 0) revert EmptyPublicKey();

            account.credentials
                .push(
                    Credential({
                        expiration: addCredential.expiration,
                        keyType: addCredential.keyType,
                        permissions: addCredential.permissions,
                        publicKey: addCredential.publicKey
                    })
                );
            account.activeCredentials++;
        } else if (mutation == REMOVE_CREDENTIAL_MUTATION) {
            RemoveCredential memory removeCredential = abi.decode(mutationData, (RemoveCredential));
            if (
                removeCredential.credentialID >= account.credentials.length
                    || account.credentials[removeCredential.credentialID].publicKey.length == 0
            ) {
                revert CredentialNotFound(authorization.accountID, removeCredential.credentialID);
            }
            if (account.activeCredentials == 1) revert LastCredential(authorization.accountID);

            delete account.credentials[removeCredential.credentialID];
            account.activeCredentials--;
        } else {
            dispatch(mutation, mutationData, authorization.accountID);
        }
    }

    function _authorizationDigest(Authorization memory authorization, uint8 mutation, bytes memory mutationData)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                AUTHORIZATION_TYPEHASH,
                authorization.accountID,
                authorization.credentialID,
                authorization.nonce,
                authorization.expiration,
                mutation,
                keccak256(mutationData)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }
}
