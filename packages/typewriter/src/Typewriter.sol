// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

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
    Credential[] credentials;
    uint256 rootCredentials;
    mapping(uint192 => uint64) nonces;
}

struct Authorization {
    bytes32 accountID;
    uint64 credentialID;
    uint256 nonce;
    uint40 expiration;
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
    "Authorization(bytes32 accountID,uint64 credentialID,uint256 nonce,uint40 expiration,uint8 mutation,bytes mutationData)"
);
bytes32 constant EXECUTE_TYPEHASH =
    keccak256("Execute(bytes32 fromExecutionHash,bytes32 toExecutionHash,uint40 timestamp,address relayer)");
bytes32 constant SCHEDULER_ADD_CREDENTIAL_TYPEHASH = keccak256(
    "SchedulerAddCredential(uint40 expiration,uint8 keyType,uint8 role,bytes publicKey,uint256 nonce,uint40 deadline)"
);
bytes32 constant SCHEDULER_REMOVE_CREDENTIAL_TYPEHASH =
    keccak256("SchedulerRemoveCredential(uint64 credentialID,uint256 nonce,uint40 deadline)");
string constant TYPEWRITER_DOMAIN_NAME = "Typewriter";
string constant TYPEWRITER_DOMAIN_VERSION = "1";

address constant P256_VERIFIER = address(0x100);

uint8 constant CREATE_ACCOUNT_MUTATION = 253;
uint8 constant ADD_CREDENTIAL_MUTATION = 254;
uint8 constant REMOVE_CREDENTIAL_MUTATION = 255;

uint256 constant ROOT_PERMISSIONS = (1 << ADD_CREDENTIAL_MUTATION) | (1 << REMOVE_CREDENTIAL_MUTATION);

function isRootCredential(uint40 expiration, uint256 permissions) pure returns (bool) {
    return expiration == 0 && permissions & ROOT_PERMISSIONS == ROOT_PERMISSIONS;
}

enum SchedulerRole {
    Executor,
    Issuer,
    Root
}

struct SchedulerCredential {
    uint40 expiration;
    KeyType keyType;
    SchedulerRole role;
    bytes publicKey;
}

struct Scheduler {
    SchedulerCredential[] credentials;
    uint256 rootCredentials;
    uint256 nonce;
}

struct SchedulerAuthorization {
    uint64 credentialID;
    bytes signature;
}

function isRootSchedulerCredential(uint40 expiration, SchedulerRole role) pure returns (bool) {
    return expiration == 0 && role == SchedulerRole.Root;
}

error UnknownMutation(uint8 mutation);
error InvalidSignature(KeyType keyType);
error AccountAlreadyExists(bytes32 accountID);
error AccountNotFound(bytes32 accountID);
error CredentialNotFound(bytes32 accountID, uint64 credentialID);
error EmptyPublicKey();
error InvalidCreateAuthorization();
error AuthorizationExpired(uint40 expiration);
error CredentialExpired(uint40 expiration);
error PermissionDenied(bytes32 accountID, uint64 credentialID, uint8 mutation);
error InvalidNonce(bytes32 accountID, uint192 lane, uint64 expected, uint64 received);
error NonceOverflow(bytes32 accountID, uint192 lane);
error LastRootCredential(bytes32 accountID, uint64 credentialID);
error NoRootSchedulerCredential();
error SchedulerCredentialNotFound(uint64 credentialID);
error SchedulerCredentialExpired(uint64 credentialID, uint40 expiration);
error SchedulerRoleDenied(uint64 signerID, SchedulerRole signerRole, SchedulerRole role);
error LastRootSchedulerCredential(uint64 credentialID);
error InvalidSchedulerNonce(uint256 expected, uint256 received);
error SchedulerDeadlineExpired(uint40 deadline);

uint256 constant MAX_SETTLEMENT_DELAY = 60;

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
    if (signature.length != 65) revert InvalidSignature(KeyType.Secp256k1);
    bytes32 r;
    bytes32 s;
    uint8 v;
    assembly ("memory-safe") {
        r := mload(add(signature, 32))
        s := mload(add(signature, 64))
        v := byte(0, mload(add(signature, 96)))
    }
    if (v < 27) v += 27;
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
        uint40 enqueuedTimestamp;
        bytes mutationData;
        bytes authorizationData;
    }

    event ForceInclusionQueued(
        uint256 index, uint8 mutation, bytes mutationData, bytes authorizationData, uint40 enqueuedTimestamp
    );

    event SchedulerCredentialAdded(uint64 credentialID, SchedulerCredential credential);
    event SchedulerCredentialRemoved(uint64 credentialID);

    error ForceInclusionTooEarly(uint256 remainingDelay);
    error ForceInclusionAlreadyExecuted(uint256 index);
    error LengthMismatch();
    error ExecutionHashMismatch(bytes32 expected, bytes32 received);
    error InvalidSettlementTimestamp(uint256 timestamp);

    bytes32 internal immutable DOMAIN_SEPARATOR;
    uint256 internal immutable FORCE_INCLUSION_DELAY = 5 minutes;

    mapping(bytes32 => Account) internal accounts;
    QueuedMutation[] internal queue;
    uint256 public executionIndex;
    bytes32 public executionHash;
    Scheduler internal scheduler;

    constructor(SchedulerCredential[] memory schedulerCredentials) {
        uint256 rootCredentials;
        for (uint256 i; i < schedulerCredentials.length; i++) {
            SchedulerCredential memory credential = schedulerCredentials[i];
            if (credential.publicKey.length == 0) revert EmptyPublicKey();
            scheduler.credentials.push(credential);
            if (isRootSchedulerCredential(credential.expiration, credential.role)) rootCredentials++;
            emit SchedulerCredentialAdded(uint64(i), credential);
        }
        if (rootCredentials == 0) revert NoRootSchedulerCredential();
        scheduler.rootCredentials = rootCredentials;
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

    function execute(
        bytes32 fromExecutionHash,
        uint40 timestamp,
        Batch calldata batch,
        uint256[] calldata forceExecuteIndexes,
        SchedulerAuthorization calldata authorization
    ) external {
        bytes32 _executionHash = executionHash;
        if (_executionHash != fromExecutionHash) revert ExecutionHashMismatch(_executionHash, fromExecutionHash);
        if (timestamp > block.timestamp || block.timestamp - timestamp > MAX_SETTLEMENT_DELAY) {
            revert InvalidSettlementTimestamp(timestamp);
        }
        if (
            batch.mutations.length != batch.mutationData.length
                || batch.mutations.length != batch.authorizationData.length
        ) {
            revert LengthMismatch();
        }

        for (uint256 i; i < batch.mutations.length; i++) {
            uint256 freeMemoryPointer = _getFreeMemoryPointer();
            _execute(batch.mutations[i], batch.mutationData[i], batch.authorizationData[i], timestamp);
            _setFreeMemoryPointer(freeMemoryPointer);
            _executionHash =
                _accumulate(_executionHash, batch.mutations[i], batch.mutationData[i], batch.authorizationData[i]);
            executionIndex++;
        }

        for (uint256 i; i < forceExecuteIndexes.length; i++) {
            uint256 index = forceExecuteIndexes[i];
            QueuedMutation storage queued = queue[index];

            if (queued.enqueuedTimestamp == 0) revert ForceInclusionAlreadyExecuted(index);

            uint256 freeMemoryPointer = _getFreeMemoryPointer();
            _execute(queued.mutation, queued.mutationData, queued.authorizationData, timestamp);
            _setFreeMemoryPointer(freeMemoryPointer);
            _executionHash = _accumulate(_executionHash, queued.mutation, queued.mutationData, queued.authorizationData);
            executionIndex++;

            delete queue[index];
        }

        bytes32 structHash =
            keccak256(abi.encode(EXECUTE_TYPEHASH, fromExecutionHash, _executionHash, timestamp, msg.sender));
        _authorizeScheduler(
            authorization, timestamp, keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash))
        );

        executionHash = _executionHash;
    }

    function _accumulate(bytes32 hash, uint8 mutation, bytes memory mutationData, bytes memory authorizationData)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(hash, mutation, keccak256(mutationData), keccak256(authorizationData)));
    }

    function _getFreeMemoryPointer() private pure returns (uint256 pointer) {
        assembly ("memory-safe") {
            pointer := mload(0x40)
        }
    }

    function _setFreeMemoryPointer(uint256 pointer) private pure {
        assembly ("memory-safe") {
            mstore(0x40, pointer)
        }
    }

    function enqueue(uint8 mutation, bytes calldata mutationData, bytes calldata authorizationData)
        external
        returns (uint256)
    {
        uint256 index = queue.length;
        uint40 enqueuedTimestamp = uint40(block.timestamp);
        queue.push(
            QueuedMutation({
                mutation: mutation,
                enqueuedTimestamp: enqueuedTimestamp,
                mutationData: mutationData,
                authorizationData: authorizationData
            })
        );
        emit ForceInclusionQueued(index, mutation, mutationData, authorizationData, enqueuedTimestamp);
        return index;
    }

    function forceExecute(uint256 index) external {
        QueuedMutation storage queued = queue[index];

        if (queued.enqueuedTimestamp == 0) revert ForceInclusionAlreadyExecuted(index);
        uint256 executableAt = queued.enqueuedTimestamp + FORCE_INCLUSION_DELAY;
        if (block.timestamp < executableAt) revert ForceInclusionTooEarly(executableAt - block.timestamp);

        _execute(queued.mutation, queued.mutationData, queued.authorizationData, block.timestamp);
        executionHash = _accumulate(executionHash, queued.mutation, queued.mutationData, queued.authorizationData);
        executionIndex++;

        delete queue[index];
    }

    function _execute(uint8 mutation, bytes memory mutationData, bytes memory authorizationData, uint256 timestamp)
        internal
    {
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

            Credential storage signer = account.credentials[authorization.credentialID];
            if (signer.publicKey.length == 0) {
                revert CredentialNotFound(authorization.accountID, authorization.credentialID);
            }
            if (authorization.expiration != 0 && authorization.expiration < timestamp) {
                revert AuthorizationExpired(authorization.expiration);
            }
            if (signer.expiration != 0 && signer.expiration < timestamp) {
                revert CredentialExpired(signer.expiration);
            }
            if (signer.permissions & (uint256(1) << mutation) == 0) {
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
            verifySignature(signer.keyType, digest, signer.publicKey, authorization.signature);
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
            account.rootCredentials = 1;
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
            if (isRootCredential(addCredential.expiration, addCredential.permissions)) {
                account.rootCredentials++;
            }
        } else if (mutation == REMOVE_CREDENTIAL_MUTATION) {
            RemoveCredential memory removeCredential = abi.decode(mutationData, (RemoveCredential));
            if (
                removeCredential.credentialID >= account.credentials.length
                    || account.credentials[removeCredential.credentialID].publicKey.length == 0
            ) {
                revert CredentialNotFound(authorization.accountID, removeCredential.credentialID);
            }
            Credential storage removed = account.credentials[removeCredential.credentialID];
            if (isRootCredential(removed.expiration, removed.permissions)) {
                if (account.rootCredentials == 1) {
                    revert LastRootCredential(authorization.accountID, removeCredential.credentialID);
                }
                account.rootCredentials--;
            }

            delete account.credentials[removeCredential.credentialID];
        } else {
            dispatch(mutation, mutationData, authorization.accountID);
        }
    }

    function schedulerAddCredential(
        SchedulerCredential calldata credential,
        uint256 nonce,
        uint40 deadline,
        SchedulerAuthorization calldata authorization
    ) external {
        _useSchedulerNonce(nonce, deadline);
        if (credential.publicKey.length == 0) revert EmptyPublicKey();
        bytes32 structHash = keccak256(
            abi.encode(
                SCHEDULER_ADD_CREDENTIAL_TYPEHASH,
                credential.expiration,
                credential.keyType,
                credential.role,
                keccak256(credential.publicKey),
                nonce,
                deadline
            )
        );
        SchedulerRole signerRole = _authorizeScheduler(
            authorization, block.timestamp, keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash))
        );
        _checkSchedulerRole(authorization.credentialID, signerRole, credential.role);

        uint64 credentialID = uint64(scheduler.credentials.length);
        scheduler.credentials
            .push(
                SchedulerCredential({
                    expiration: credential.expiration,
                    keyType: credential.keyType,
                    role: credential.role,
                    publicKey: credential.publicKey
                })
            );
        if (isRootSchedulerCredential(credential.expiration, credential.role)) scheduler.rootCredentials++;
        emit SchedulerCredentialAdded(credentialID, credential);
    }

    function schedulerRemoveCredential(
        uint64 credentialID,
        uint256 nonce,
        uint40 deadline,
        SchedulerAuthorization calldata authorization
    ) external {
        _useSchedulerNonce(nonce, deadline);
        SchedulerCredential[] storage credentials = scheduler.credentials;
        if (credentialID >= credentials.length || credentials[credentialID].publicKey.length == 0) {
            revert SchedulerCredentialNotFound(credentialID);
        }
        bytes32 structHash = keccak256(abi.encode(SCHEDULER_REMOVE_CREDENTIAL_TYPEHASH, credentialID, nonce, deadline));
        SchedulerRole signerRole = _authorizeScheduler(
            authorization, block.timestamp, keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash))
        );
        SchedulerCredential storage removed = credentials[credentialID];
        _checkSchedulerRole(authorization.credentialID, signerRole, removed.role);
        if (isRootSchedulerCredential(removed.expiration, removed.role)) {
            if (scheduler.rootCredentials == 1) revert LastRootSchedulerCredential(credentialID);
            scheduler.rootCredentials--;
        }

        delete credentials[credentialID];
        emit SchedulerCredentialRemoved(credentialID);
    }

    function schedulerNonce() external view returns (uint256) {
        return scheduler.nonce;
    }

    function _useSchedulerNonce(uint256 nonce, uint40 deadline) private {
        uint256 expected = scheduler.nonce;
        if (nonce != expected) revert InvalidSchedulerNonce(expected, nonce);
        if (deadline != 0 && block.timestamp > deadline) revert SchedulerDeadlineExpired(deadline);
        scheduler.nonce = expected + 1;
    }

    function _checkSchedulerRole(uint64 signerID, SchedulerRole signerRole, SchedulerRole role) private pure {
        if (signerRole < SchedulerRole.Issuer || (role >= signerRole && signerRole != SchedulerRole.Root)) {
            revert SchedulerRoleDenied(signerID, signerRole, role);
        }
    }

    function _authorizeScheduler(SchedulerAuthorization calldata authorization, uint256 timestamp, bytes32 digest)
        internal
        view
        returns (SchedulerRole)
    {
        uint64 credentialID = authorization.credentialID;
        SchedulerCredential[] storage credentials = scheduler.credentials;
        if (credentialID >= credentials.length) revert SchedulerCredentialNotFound(credentialID);
        SchedulerCredential storage credential = credentials[credentialID];
        bytes memory publicKey = credential.publicKey;
        if (publicKey.length == 0) revert SchedulerCredentialNotFound(credentialID);
        uint40 expiration = credential.expiration;
        if (expiration != 0 && expiration < timestamp) revert SchedulerCredentialExpired(credentialID, expiration);
        KeyType keyType = credential.keyType;
        if (keyType != KeyType.Secp256k1 || abi.decode(publicKey, (address)) != msg.sender) {
            verifySignature(keyType, digest, publicKey, authorization.signature);
        }
        return credential.role;
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
