// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {
    ADD_CREDENTIAL_MUTATION,
    SCHEDULER_ADD_CREDENTIAL_TYPEHASH,
    AUTHORIZATION_TYPEHASH,
    CREATE_ACCOUNT_MUTATION,
    EIP712_DOMAIN_TYPEHASH,
    EXECUTE_TYPEHASH,
    REMOVE_CREDENTIAL_MUTATION,
    SCHEDULER_REMOVE_CREDENTIAL_TYPEHASH,
    Account,
    AddCredential,
    Authorization,
    AuthorizationExpired,
    CreateAccount,
    Credential,
    CredentialExpired,
    CredentialNotFound,
    EmptyPublicKey,
    InvalidCreateAuthorization,
    InvalidNonce,
    InvalidSignature,
    KeyType,
    LastRootCredential,
    NoRootSchedulerCredential,
    NonceOverflow,
    PermissionDenied,
    RemoveCredential,
    SchedulerAuthorization,
    SchedulerCredential,
    SchedulerRole,
    SchedulerRoleDenied,
    Typewriter,
    UnknownMutation,
    verifyChallenge,
    verifySignature
} from "typewriter/Typewriter.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function signP256(uint256 privateKey, bytes32 digest) external returns (bytes32 r, bytes32 s);
    function publicKeyP256(uint256 privateKey) external returns (uint256 x, uint256 y);
    function warp(uint256 timestamp) external;
}

contract AccountHarness {
    function verifySignatureExternal(KeyType keyType, bytes32 digest, bytes memory publicKey, bytes calldata signature)
        external
        view
    {
        verifySignature(keyType, digest, publicKey, signature);
    }

    function verifyChallengeExternal(bytes memory clientDataJSON, uint256 offset, bytes32 digest) external pure {
        verifyChallenge(clientDataJSON, offset, digest);
    }
}

struct SetValue {
    uint256 value;
}

contract NativeAccountHarness is Typewriter {
    uint8 constant SET_VALUE_MUTATION = 0;

    uint256 public value;
    bytes32 public lastAccountID;

    constructor(SchedulerCredential[] memory schedulerCredentials) Typewriter(schedulerCredentials) {}

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID) internal override {
        if (mutation != SET_VALUE_MUTATION) revert UnknownMutation(mutation);
        SetValue memory setValue = abi.decode(mutationData, (SetValue));
        value = setValue.value;
        lastAccountID = accountID;
    }

    function domainSeparator() external view returns (bytes32) {
        return DOMAIN_SEPARATOR;
    }

    function authorizationDigest(Authorization memory authorization, uint8 mutation, bytes memory mutationData)
        external
        view
        returns (bytes32)
    {
        return _authorizationDigest(authorization, mutation, mutationData);
    }

    function executeDigest(bytes32 fromExecutionHash, bytes32 toExecutionHash, uint40 timestamp, address relayer)
        external
        view
        returns (bytes32)
    {
        return
            _typedDataHash(
                keccak256(abi.encode(EXECUTE_TYPEHASH, fromExecutionHash, toExecutionHash, timestamp, relayer))
            );
    }

    function schedulerAddCredentialDigest(SchedulerCredential memory added, uint256 schedulerNonce_, uint40 deadline)
        external
        view
        returns (bytes32)
    {
        return _typedDataHash(
            keccak256(
                abi.encode(
                    SCHEDULER_ADD_CREDENTIAL_TYPEHASH,
                    added.expiration,
                    added.keyType,
                    added.role,
                    keccak256(added.publicKey),
                    schedulerNonce_,
                    deadline
                )
            )
        );
    }

    function schedulerRemoveCredentialDigest(uint64 credentialID, uint256 schedulerNonce_, uint40 deadline)
        external
        view
        returns (bytes32)
    {
        return _typedDataHash(
            keccak256(abi.encode(SCHEDULER_REMOVE_CREDENTIAL_TYPEHASH, credentialID, schedulerNonce_, deadline))
        );
    }

    function _typedDataHash(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function accountState(bytes32 accountID) external view returns (uint256 credentialCount, uint256 rootCredentials) {
        Account storage account = accounts[accountID];
        return (account.credentials.length, account.rootCredentials);
    }

    function credential(bytes32 accountID, uint64 credentialID) external view returns (Credential memory) {
        return accounts[accountID].credentials[credentialID];
    }

    function nonce(bytes32 accountID, uint192 lane) external view returns (uint64) {
        return accounts[accountID].nonces[lane];
    }
}

contract AccountTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    AccountHarness harness;
    NativeAccountHarness nativeHarness;

    uint256 constant SECP256K1_PK = 0xA11CE;
    uint256 constant SECP256K1_CREDENTIAL_PK = 0xB0B;
    uint256 constant P256_PK = 0xC0FFEE;
    uint256 constant P256_OTHER_PK = 0xDECAF;

    bytes32 constant DIGEST = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
    string constant CLIENT_DATA_JSON =
        '{"type":"webauthn.get","challenge":"ERERERERERERERERERERERERERERERERERERERERERE","origin":"http://localhost:3000","crossOrigin":false}';
    uint256 constant CHALLENGE_OFFSET = 36;

    // The scheduler: a root, an issuer and an executor.
    uint256 constant ROOT_PK = 0x5007;
    uint256 constant ISSUER_PK = 0x155E;
    uint256 constant EXECUTOR_PK = 0x516E;
    uint256 constant NEW_PK = 0x7E57;
    uint64 constant ROOT_ID = 0;
    uint64 constant ISSUER_ID = 1;
    uint64 constant EXECUTOR_ID = 2;

    function setUp() public {
        harness = new AccountHarness();
        nativeHarness = new NativeAccountHarness(_schedulerCredentials());
    }

    function _schedulerCredentials() internal returns (SchedulerCredential[] memory credentials) {
        credentials = new SchedulerCredential[](3);
        credentials[ROOT_ID] = _schedulerCredential(ROOT_PK, SchedulerRole.Root, 0);
        credentials[ISSUER_ID] = _schedulerCredential(ISSUER_PK, SchedulerRole.Issuer, 0);
        credentials[EXECUTOR_ID] = _schedulerCredential(EXECUTOR_PK, SchedulerRole.Executor, 0);
    }

    function test_verifySignature_acceptsSecp256k1() external {
        harness.verifySignatureExternal(
            KeyType.Secp256k1, DIGEST, _secp256k1PublicKey(SECP256K1_PK), _signSecp256k1(SECP256K1_PK, DIGEST)
        );
    }

    function test_verifySignature_acceptsSecp256k1WithYParity() external {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SECP256K1_PK, DIGEST);
        harness.verifySignatureExternal(
            KeyType.Secp256k1, DIGEST, _secp256k1PublicKey(SECP256K1_PK), abi.encodePacked(r, s, v - 27)
        );
    }

    function test_verifySignature_rejectsSecp256k1OfTheWrongLength() external {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SECP256K1_PK, DIGEST);
        bytes memory abiEncoded = abi.encode(v, r, s);
        _expectInvalidSignature(
            abi.encodeCall(
                harness.verifySignatureExternal,
                (KeyType.Secp256k1, DIGEST, _secp256k1PublicKey(SECP256K1_PK), abiEncoded)
            ),
            KeyType.Secp256k1
        );
    }

    function test_verifySignature_rejectsSecp256k1ForWrongPublicKey() external {
        bytes memory signature = _signSecp256k1(SECP256K1_PK, DIGEST);
        bytes memory wrongPublicKey = abi.encode(vm.addr(0xB0B));

        _expectInvalidSignature(
            abi.encodeCall(harness.verifySignatureExternal, (KeyType.Secp256k1, DIGEST, wrongPublicKey, signature)),
            KeyType.Secp256k1
        );
    }

    function test_verifySignature_acceptsP256() external {
        harness.verifySignatureExternal(KeyType.P256, DIGEST, _p256PublicKey(P256_PK), _signP256(P256_PK, DIGEST));
    }

    function test_verifySignature_acceptsAbiEncodedP256PublicKey() external {
        (uint256 x, uint256 y) = vm.publicKeyP256(P256_PK);

        harness.verifySignatureExternal(KeyType.P256, DIGEST, abi.encode(x, y), _signP256(P256_PK, DIGEST));
    }

    function test_verifySignature_rejectsP256ForWrongDigest() external {
        _expectInvalidSignature(
            abi.encodeCall(
                harness.verifySignatureExternal,
                (KeyType.P256, bytes32(uint256(0x2222)), _p256PublicKey(P256_PK), _signP256(P256_PK, DIGEST))
            ),
            KeyType.P256
        );
    }

    function test_verifySignature_rejectsP256ForWrongPublicKey() external {
        _expectInvalidSignature(
            abi.encodeCall(
                harness.verifySignatureExternal,
                (KeyType.P256, DIGEST, _p256PublicKey(P256_PK), _signP256(P256_OTHER_PK, DIGEST))
            ),
            KeyType.P256
        );
    }

    function test_verifySignature_acceptsWebAuthnP256() external {
        harness.verifySignatureExternal(
            KeyType.WebAuthnP256, DIGEST, _p256PublicKey(P256_PK), _signWebAuthnP256(P256_PK)
        );
    }

    function test_verifySignature_rejectsWebAuthnP256ForWrongChallengeOffset() external {
        bytes memory signature = _signWebAuthnP256(P256_PK, CHALLENGE_OFFSET + 1);

        _expectInvalidSignature(
            abi.encodeCall(
                harness.verifySignatureExternal, (KeyType.WebAuthnP256, DIGEST, _p256PublicKey(P256_PK), signature)
            ),
            KeyType.WebAuthnP256
        );
    }

    function test_verifyChallenge_acceptsCorrectBase64Challenge() external view {
        harness.verifyChallengeExternal(bytes(CLIENT_DATA_JSON), CHALLENGE_OFFSET, DIGEST);
    }

    function test_verifyChallenge_rejectsMismatchedDigest() external {
        _expectInvalidSignature(
            abi.encodeCall(
                harness.verifyChallengeExternal, (bytes(CLIENT_DATA_JSON), CHALLENGE_OFFSET, bytes32(uint256(0x2222)))
            ),
            KeyType.WebAuthnP256
        );
    }

    function test_verifyChallenge_rejectsTooShortJson() external {
        _expectInvalidSignature(
            abi.encodeCall(harness.verifyChallengeExternal, (bytes('{"challenge":"ERERERER"}'), 14, DIGEST)),
            KeyType.WebAuthnP256
        );
    }

    function test_authorizationDigest_matchesFixedEip712Envelope() external view {
        require(
            AUTHORIZATION_TYPEHASH == 0x1c6385e6c2f0b9e8999af339ea51493e8339f6d465a47a4e0635b97b15e73db3,
            "authorization typehash"
        );

        Authorization memory authorization = Authorization({
            accountID: bytes32(uint256(0xA11CE)),
            credentialID: 7,
            nonce: (uint256(11) << 64) | 4,
            expiration: 123456,
            signature: hex"1234"
        });
        bytes memory mutationData = hex"01020304";
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Typewriter")),
                keccak256(bytes("1")),
                block.chainid,
                address(nativeHarness)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                AUTHORIZATION_TYPEHASH,
                authorization.accountID,
                authorization.credentialID,
                authorization.nonce,
                authorization.expiration,
                uint8(42),
                keccak256(mutationData)
            )
        );
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        require(nativeHarness.domainSeparator() == domainSeparator, "domain separator");
        require(nativeHarness.authorizationDigest(authorization, 42, mutationData) == expected, "digest");
    }

    function test_nativeAccountLifecycle_keepsStableCredentialIDs() external {
        bytes32 accountID = _createNativeAccount(SECP256K1_PK);

        {
            (uint256 credentialCount, uint256 rootCredentials) = nativeHarness.accountState(accountID);
            require(credentialCount == 1 && rootCredentials == 1, "root account state");
            Credential memory root = nativeHarness.credential(accountID, 0);
            require(root.expiration == 0, "root expiration");
            require(root.keyType == KeyType.Secp256k1, "root key type");
            require(root.permissions == type(uint256).max, "root permissions");
            require(keccak256(root.publicKey) == keccak256(_secp256k1PublicKey(SECP256K1_PK)), "root public key");
        }

        AddCredential memory addCredential = AddCredential({
            expiration: 0,
            keyType: KeyType.Secp256k1,
            permissions: 1,
            publicKey: _secp256k1PublicKey(SECP256K1_CREDENTIAL_PK)
        });
        {
            Authorization memory addAuthorization = _signNativeAuthorization(
                accountID, 0, 0, 0, ADD_CREDENTIAL_MUTATION, abi.encode(addCredential), SECP256K1_PK
            );
            _executeNative(ADD_CREDENTIAL_MUTATION, abi.encode(addCredential), addAuthorization);
        }

        {
            (uint256 credentialCount, uint256 rootCredentials) = nativeHarness.accountState(accountID);
            require(credentialCount == 2 && rootCredentials == 1, "added credential");
        }
        require(nativeHarness.nonce(accountID, 0) == 1, "add nonce");

        RemoveCredential memory removeCredential = RemoveCredential({credentialID: 1});
        {
            Authorization memory removeAuthorization = _signNativeAuthorization(
                accountID, 0, 1, 0, REMOVE_CREDENTIAL_MUTATION, abi.encode(removeCredential), SECP256K1_PK
            );
            _executeNative(REMOVE_CREDENTIAL_MUTATION, abi.encode(removeCredential), removeAuthorization);
        }

        {
            (uint256 credentialCount, uint256 rootCredentials) = nativeHarness.accountState(accountID);
            require(credentialCount == 2 && rootCredentials == 1, "removed credential");
            require(nativeHarness.credential(accountID, 1).publicKey.length == 0, "deleted credential");
        }

        {
            Authorization memory addAuthorization = _signNativeAuthorization(
                accountID, 0, 2, 0, ADD_CREDENTIAL_MUTATION, abi.encode(addCredential), SECP256K1_PK
            );
            _executeNative(ADD_CREDENTIAL_MUTATION, abi.encode(addCredential), addAuthorization);
        }

        {
            (uint256 credentialCount, uint256 rootCredentials) = nativeHarness.accountState(accountID);
            require(credentialCount == 3 && rootCredentials == 1, "stable credential ID");
            require(nativeHarness.credential(accountID, 2).publicKey.length != 0, "appended credential");
        }
    }

    function test_nativeAccount_usesPackedNonceLanesAndRejectsReplay() external {
        bytes32 accountID = _createNativeAccount(SECP256K1_PK);
        SetValue memory setValue = SetValue({value: 99});
        uint192 lane = 17;
        uint256 packedNonce = uint256(lane) << 64;
        Authorization memory authorization =
            _signNativeAuthorization(accountID, 0, packedNonce, 0, 0, abi.encode(setValue), SECP256K1_PK);

        _executeNative(0, abi.encode(setValue), authorization);

        require(nativeHarness.value() == 99, "dispatched value");
        require(nativeHarness.lastAccountID() == accountID, "dispatched account");
        require(nativeHarness.nonce(accountID, lane) == 1, "lane nonce");
        require(nativeHarness.nonce(accountID, 0) == 0, "independent lane");
        _expectNativeRevert(
            0,
            abi.encode(setValue),
            authorization,
            abi.encodeWithSelector(InvalidNonce.selector, accountID, lane, uint64(1), uint64(0))
        );
    }

    function test_nativeAccount_rejectsExpiredAuthorizationButAcceptsExactDeadline() external {
        bytes32 accountID = _createNativeAccount(SECP256K1_PK);
        vm.warp(100);
        SetValue memory setValue = SetValue({value: 7});
        Authorization memory expired =
            _signNativeAuthorization(accountID, 0, 0, 99, 0, abi.encode(setValue), SECP256K1_PK);
        _expectNativeRevert(
            0, abi.encode(setValue), expired, abi.encodeWithSelector(AuthorizationExpired.selector, uint256(99))
        );

        Authorization memory exactDeadline =
            _signNativeAuthorization(accountID, 0, 0, 100, 0, abi.encode(setValue), SECP256K1_PK);
        _executeNative(0, abi.encode(setValue), exactDeadline);
        require(nativeHarness.value() == 7, "exact deadline");
    }

    function test_nativeAccount_enforcesCredentialExpirationAndPermissions() external {
        bytes32 accountID = _createNativeAccount(SECP256K1_PK);
        AddCredential memory addCredential = AddCredential({
            expiration: 110,
            keyType: KeyType.Secp256k1,
            permissions: 1,
            publicKey: _secp256k1PublicKey(SECP256K1_CREDENTIAL_PK)
        });
        Authorization memory rootAuthorization = _signNativeAuthorization(
            accountID, 0, 0, 0, ADD_CREDENTIAL_MUTATION, abi.encode(addCredential), SECP256K1_PK
        );
        _executeNative(ADD_CREDENTIAL_MUTATION, abi.encode(addCredential), rootAuthorization);

        AddCredential memory anotherCredential = AddCredential({
            expiration: 0,
            keyType: KeyType.Secp256k1,
            permissions: type(uint256).max,
            publicKey: _secp256k1PublicKey(0xCAFE)
        });
        Authorization memory unauthorizedAdd = _signNativeAuthorization(
            accountID, 1, 0, 0, ADD_CREDENTIAL_MUTATION, abi.encode(anotherCredential), SECP256K1_CREDENTIAL_PK
        );
        _expectNativeRevert(
            ADD_CREDENTIAL_MUTATION,
            abi.encode(anotherCredential),
            unauthorizedAdd,
            abi.encodeWithSelector(PermissionDenied.selector, accountID, uint64(1), ADD_CREDENTIAL_MUTATION)
        );

        vm.warp(111);
        SetValue memory setValue = SetValue({value: 1});
        Authorization memory expiredCredential =
            _signNativeAuthorization(accountID, 1, 0, 0, 0, abi.encode(setValue), SECP256K1_CREDENTIAL_PK);
        _expectNativeRevert(
            0, abi.encode(setValue), expiredCredential, abi.encodeWithSelector(CredentialExpired.selector, uint40(110))
        );
    }

    function test_nativeAccount_cannotRemoveLastOrUseDeletedCredential() external {
        bytes32 accountID = _createNativeAccount(SECP256K1_PK);
        RemoveCredential memory removeRoot = RemoveCredential({credentialID: 0});
        Authorization memory removeRootAuthorization = _signNativeAuthorization(
            accountID, 0, 0, 0, REMOVE_CREDENTIAL_MUTATION, abi.encode(removeRoot), SECP256K1_PK
        );
        _expectNativeRevert(
            REMOVE_CREDENTIAL_MUTATION,
            abi.encode(removeRoot),
            removeRootAuthorization,
            abi.encodeWithSelector(LastRootCredential.selector, accountID, uint64(0))
        );
        require(nativeHarness.nonce(accountID, 0) == 0, "last removal nonce");

        AddCredential memory addCredential = AddCredential({
            expiration: 0,
            keyType: KeyType.Secp256k1,
            permissions: type(uint256).max,
            publicKey: _secp256k1PublicKey(SECP256K1_CREDENTIAL_PK)
        });
        Authorization memory addAuthorization = _signNativeAuthorization(
            accountID, 0, 0, 0, ADD_CREDENTIAL_MUTATION, abi.encode(addCredential), SECP256K1_PK
        );
        _executeNative(ADD_CREDENTIAL_MUTATION, abi.encode(addCredential), addAuthorization);

        RemoveCredential memory removeAdded = RemoveCredential({credentialID: 1});
        Authorization memory removeAddedAuthorization = _signNativeAuthorization(
            accountID, 0, 1, 0, REMOVE_CREDENTIAL_MUTATION, abi.encode(removeAdded), SECP256K1_PK
        );
        _executeNative(REMOVE_CREDENTIAL_MUTATION, abi.encode(removeAdded), removeAddedAuthorization);

        SetValue memory setValue = SetValue({value: 1});
        Authorization memory deletedCredential =
            _signNativeAuthorization(accountID, 1, 0, 0, 0, abi.encode(setValue), SECP256K1_CREDENTIAL_PK);
        _expectNativeRevert(
            0,
            abi.encode(setValue),
            deletedCredential,
            abi.encodeWithSelector(CredentialNotFound.selector, accountID, uint64(1))
        );
    }

    function test_nativeAccount_explicitlyRejectsNonceSequenceOverflow() external {
        bytes32 accountID = _createNativeAccount(SECP256K1_PK);
        SetValue memory setValue = SetValue({value: 1});
        uint192 lane = 3;
        Authorization memory authorization = Authorization({
            accountID: accountID,
            credentialID: 0,
            nonce: (uint256(lane) << 64) | type(uint64).max,
            expiration: 0,
            signature: hex"01"
        });
        _expectNativeRevert(
            0, abi.encode(setValue), authorization, abi.encodeWithSelector(NonceOverflow.selector, accountID, lane)
        );
    }

    function test_nativeAccount_rejectsMismatchedCreateAuthorization() external {
        CreateAccount memory createAccount =
            CreateAccount({keyType: KeyType.Secp256k1, publicKey: _secp256k1PublicKey(SECP256K1_PK)});
        Authorization memory authorization = Authorization({
            accountID: bytes32(uint256(1)), credentialID: 0, nonce: 0, expiration: 0, signature: hex"01"
        });
        _expectNativeRevert(
            CREATE_ACCOUNT_MUTATION,
            abi.encode(createAccount),
            authorization,
            abi.encodeWithSelector(InvalidCreateAuthorization.selector)
        );
    }

    function test_nativeAccount_enqueuedMutationUsesSameAuthorizationPath() external {
        bytes32 accountID = _createNativeAccount(SECP256K1_PK);
        SetValue memory setValue = SetValue({value: 55});
        Authorization memory authorization =
            _signNativeAuthorization(accountID, 0, 0, 0, 0, abi.encode(setValue), SECP256K1_PK);
        uint256 queuedIndex = nativeHarness.enqueue(0, abi.encode(setValue), abi.encode(authorization));
        Typewriter.Batch memory batch;
        uint256[] memory forceExecuteIndexes = new uint256[](1);
        forceExecuteIndexes[0] = queuedIndex;

        bytes32 fromExecutionHash = nativeHarness.executionHash();
        bytes32 toExecutionHash = _accumulate(fromExecutionHash, 0, abi.encode(setValue), abi.encode(authorization));
        nativeHarness.execute(
            fromExecutionHash,
            uint40(block.timestamp),
            batch,
            forceExecuteIndexes,
            SchedulerAuthorization(
                EXECUTOR_ID, _signExecute(EXECUTOR_PK, fromExecutionHash, toExecutionHash, address(this))
            )
        );

        require(nativeHarness.value() == 55, "queued dispatch");
        require(nativeHarness.nonce(accountID, 0) == 1, "queued nonce");
    }

    function test_execute_rejectsAnotherExecutionHash() external {
        bytes32 executionHash = nativeHarness.executionHash();
        bytes32 other = keccak256("other");
        (bool ok, bytes memory ret) = address(nativeHarness)
            .call(
                abi.encodeCall(
                    nativeHarness.execute,
                    (
                        other,
                        uint40(block.timestamp),
                        _emptyBatch(),
                        new uint256[](0),
                        SchedulerAuthorization(EXECUTOR_ID, "")
                    )
                )
            );
        require(!ok, "expected execute to revert");
        require(
            keccak256(ret)
                == keccak256(abi.encodeWithSelector(Typewriter.ExecutionHashMismatch.selector, executionHash, other)),
            "wrong revert"
        );
    }

    function test_forceExecute_waitsForTheDelayInSeconds() external {
        vm.warp(1000);
        bytes32 accountID = _createNativeAccount(SECP256K1_PK);
        SetValue memory setValue = SetValue({value: 77});
        Authorization memory authorization =
            _signNativeAuthorization(accountID, 0, 0, 0, 0, abi.encode(setValue), SECP256K1_PK);
        uint256 queuedIndex = nativeHarness.enqueue(0, abi.encode(setValue), abi.encode(authorization));

        vm.warp(1000 + 5 minutes - 1);
        _expectForceExecuteRevert(
            queuedIndex, abi.encodeWithSelector(Typewriter.ForceInclusionTooEarly.selector, uint256(1))
        );

        vm.warp(1000 + 5 minutes);
        nativeHarness.forceExecute(queuedIndex);
        require(nativeHarness.value() == 77, "force executed");

        _expectForceExecuteRevert(
            queuedIndex, abi.encodeWithSelector(Typewriter.ForceInclusionAlreadyExecuted.selector, queuedIndex)
        );
    }

    function test_constructor_rejectsNoRootThatNeverExpires() external {
        SchedulerCredential[] memory credentials = _schedulerCredentials();
        credentials[ROOT_ID].expiration = uint40(block.timestamp + 1 days);
        _expectConstructorRevert(credentials, abi.encodeWithSelector(NoRootSchedulerCredential.selector));
    }

    function test_constructor_rejectsEmptyPublicKey() external {
        SchedulerCredential[] memory credentials = _schedulerCredentials();
        credentials[ISSUER_ID].publicKey = "";
        _expectConstructorRevert(credentials, abi.encodeWithSelector(EmptyPublicKey.selector));
    }

    function test_issuer_managesExecutorsOnly() external {
        SchedulerCredential memory executor = _schedulerCredential(NEW_PK, SchedulerRole.Executor, 0);
        _schedulerAddCredential(executor, ISSUER_ID, ISSUER_PK);
        _schedulerRemoveCredential(3, ISSUER_ID, ISSUER_PK);
        _schedulerRemoveCredential(EXECUTOR_ID, ISSUER_ID, ISSUER_PK);

        _expectSchedulerAddCredentialRevert(
            _schedulerCredential(NEW_PK, SchedulerRole.Issuer, 0),
            ISSUER_ID,
            ISSUER_PK,
            abi.encodeWithSelector(SchedulerRoleDenied.selector, ISSUER_ID, SchedulerRole.Issuer, SchedulerRole.Issuer)
        );
        _expectSchedulerAddCredentialRevert(
            _schedulerCredential(NEW_PK, SchedulerRole.Root, 0),
            ISSUER_ID,
            ISSUER_PK,
            abi.encodeWithSelector(SchedulerRoleDenied.selector, ISSUER_ID, SchedulerRole.Issuer, SchedulerRole.Root)
        );
        _expectSchedulerRemoveCredentialRevert(
            ISSUER_ID,
            ISSUER_ID,
            ISSUER_PK,
            abi.encodeWithSelector(SchedulerRoleDenied.selector, ISSUER_ID, SchedulerRole.Issuer, SchedulerRole.Issuer)
        );
        _expectSchedulerRemoveCredentialRevert(
            ROOT_ID,
            ISSUER_ID,
            ISSUER_PK,
            abi.encodeWithSelector(SchedulerRoleDenied.selector, ISSUER_ID, SchedulerRole.Issuer, SchedulerRole.Root)
        );
    }

    function test_schedulerDigests_matchFixedEip712Envelopes() external view {
        require(
            EXECUTE_TYPEHASH
                == keccak256(
                    "Execute(bytes32 fromExecutionHash,bytes32 toExecutionHash,uint40 timestamp,address relayer)"
                ),
            "execute typehash"
        );
        require(
            SCHEDULER_ADD_CREDENTIAL_TYPEHASH
                == keccak256(
                    "SchedulerAddCredential(uint40 expiration,uint8 keyType,uint8 role,bytes publicKey,uint256 nonce,uint40 deadline)"
                ),
            "add typehash"
        );
        require(
            SCHEDULER_REMOVE_CREDENTIAL_TYPEHASH
                == keccak256("SchedulerRemoveCredential(uint64 credentialID,uint256 nonce,uint40 deadline)"),
            "remove typehash"
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Typewriter")),
                keccak256(bytes("1")),
                block.chainid,
                address(nativeHarness)
            )
        );

        bytes32 from = keccak256("from");
        bytes32 to = keccak256("to");
        address relayer = address(0xBEEF);
        bytes32 structHash = keccak256(abi.encode(EXECUTE_TYPEHASH, from, to, uint40(1234), relayer));
        require(
            nativeHarness.executeDigest(from, to, 1234, relayer)
                == keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)),
            "execute digest"
        );

        SchedulerCredential memory credential = SchedulerCredential({
            expiration: 99, keyType: KeyType.P256, role: SchedulerRole.Issuer, publicKey: hex"0102"
        });
        structHash = keccak256(
            abi.encode(
                SCHEDULER_ADD_CREDENTIAL_TYPEHASH,
                uint40(99),
                uint8(KeyType.P256),
                uint8(SchedulerRole.Issuer),
                keccak256(hex"0102"),
                uint256(5),
                uint40(77)
            )
        );
        require(
            nativeHarness.schedulerAddCredentialDigest(credential, 5, 77)
                == keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)),
            "add digest"
        );

        structHash = keccak256(abi.encode(SCHEDULER_REMOVE_CREDENTIAL_TYPEHASH, uint64(4), uint256(5), uint40(77)));
        require(
            nativeHarness.schedulerRemoveCredentialDigest(4, 5, 77)
                == keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)),
            "remove digest"
        );
    }

    function _expectConstructorRevert(SchedulerCredential[] memory credentials, bytes memory expected) internal {
        try new NativeAccountHarness(credentials) {
            revert("expected the constructor to revert");
        } catch (bytes memory reason) {
            require(keccak256(reason) == keccak256(expected), "wrong revert");
        }
    }

    function _schedulerCredential(uint256 privateKey, SchedulerRole role, uint40 expiration)
        internal
        returns (SchedulerCredential memory)
    {
        return SchedulerCredential({
            expiration: expiration, keyType: KeyType.Secp256k1, role: role, publicKey: _secp256k1PublicKey(privateKey)
        });
    }

    function _callSchedulerAddCredential(SchedulerCredential memory credential, uint64 signerID, uint256 privateKey)
        internal
        returns (bool, bytes memory)
    {
        uint256 nonce = nativeHarness.schedulerNonce();
        bytes memory signature =
            _signSecp256k1(privateKey, nativeHarness.schedulerAddCredentialDigest(credential, nonce, 0));
        return address(nativeHarness)
            .call(
                abi.encodeCall(
                    nativeHarness.schedulerAddCredential,
                    (credential, nonce, 0, SchedulerAuthorization(signerID, signature))
                )
            );
    }

    function _callSchedulerRemoveCredential(uint64 credentialID, uint64 signerID, uint256 privateKey)
        internal
        returns (bool, bytes memory)
    {
        uint256 nonce = nativeHarness.schedulerNonce();
        bytes memory signature =
            _signSecp256k1(privateKey, nativeHarness.schedulerRemoveCredentialDigest(credentialID, nonce, 0));
        return address(nativeHarness)
            .call(
                abi.encodeCall(
                    nativeHarness.schedulerRemoveCredential,
                    (credentialID, nonce, 0, SchedulerAuthorization(signerID, signature))
                )
            );
    }

    function _schedulerAddCredential(SchedulerCredential memory credential, uint64 signerID, uint256 privateKey)
        internal
    {
        (bool ok, bytes memory ret) = _callSchedulerAddCredential(credential, signerID, privateKey);
        _bubble(ok, ret);
    }

    function _expectSchedulerAddCredentialRevert(
        SchedulerCredential memory credential,
        uint64 signerID,
        uint256 privateKey,
        bytes memory expected
    ) internal {
        (bool ok, bytes memory ret) = _callSchedulerAddCredential(credential, signerID, privateKey);
        require(!ok, "expected schedulerAddCredential to revert");
        require(keccak256(ret) == keccak256(expected), "wrong schedulerAddCredential revert");
    }

    function _schedulerRemoveCredential(uint64 credentialID, uint64 signerID, uint256 privateKey) internal {
        (bool ok, bytes memory ret) = _callSchedulerRemoveCredential(credentialID, signerID, privateKey);
        _bubble(ok, ret);
    }

    function _expectSchedulerRemoveCredentialRevert(
        uint64 credentialID,
        uint64 signerID,
        uint256 privateKey,
        bytes memory expected
    ) internal {
        (bool ok, bytes memory ret) = _callSchedulerRemoveCredential(credentialID, signerID, privateKey);
        require(!ok, "expected schedulerRemoveCredential to revert");
        require(keccak256(ret) == keccak256(expected), "wrong schedulerRemoveCredential revert");
    }

    function _bubble(bool ok, bytes memory ret) internal pure {
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function _expectForceExecuteRevert(uint256 index, bytes memory expected) internal {
        (bool ok, bytes memory ret) = address(nativeHarness).call(abi.encodeCall(nativeHarness.forceExecute, (index)));
        require(!ok, "expected forceExecute to revert");
        require(keccak256(ret) == keccak256(expected), "wrong revert");
    }

    function _expectInvalidSignature(bytes memory callData, KeyType keyType) internal {
        (bool ok, bytes memory ret) = address(harness).call(callData);
        require(!ok, "expected call to revert");
        require(keccak256(ret) == keccak256(abi.encodeWithSelector(InvalidSignature.selector, keyType)), "wrong revert");
    }

    function _secp256k1PublicKey(uint256 privateKey) internal returns (bytes memory) {
        return abi.encode(vm.addr(privateKey));
    }

    function _signSecp256k1(uint256 privateKey, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _p256PublicKey(uint256 privateKey) internal returns (bytes memory) {
        (uint256 x, uint256 y) = vm.publicKeyP256(privateKey);
        return abi.encodePacked(uint8(0x04), x, y);
    }

    function _signP256(uint256 privateKey, bytes32 digest) internal returns (bytes memory) {
        (bytes32 r, bytes32 s) = vm.signP256(privateKey, sha256(abi.encodePacked(digest)));
        return abi.encode(uint256(r), uint256(s));
    }

    function _signWebAuthnP256(uint256 privateKey) internal returns (bytes memory) {
        return _signWebAuthnP256(privateKey, CHALLENGE_OFFSET);
    }

    function _signWebAuthnP256(uint256 privateKey, uint256 challengeOffset) internal returns (bytes memory) {
        bytes memory authData = hex"49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97630100000000";
        bytes memory clientDataJSON = bytes(CLIENT_DATA_JSON);
        bytes32 message = sha256(abi.encodePacked(authData, sha256(clientDataJSON)));
        (bytes32 r, bytes32 s) = vm.signP256(privateKey, message);
        return abi.encode(authData, clientDataJSON, challengeOffset, uint256(r), uint256(s));
    }

    function _createNativeAccount(uint256 privateKey) internal returns (bytes32 accountID) {
        CreateAccount memory createAccount =
            CreateAccount({keyType: KeyType.Secp256k1, publicKey: _secp256k1PublicKey(privateKey)});
        accountID = keccak256(abi.encode(createAccount.keyType, createAccount.publicKey));
        Authorization memory authorization =
            Authorization({accountID: accountID, credentialID: 0, nonce: 0, expiration: 0, signature: bytes("")});
        bytes32 authorizationDigest =
            nativeHarness.authorizationDigest(authorization, CREATE_ACCOUNT_MUTATION, abi.encode(createAccount));
        authorization.signature = _signSecp256k1(privateKey, authorizationDigest);
        _executeNative(CREATE_ACCOUNT_MUTATION, abi.encode(createAccount), authorization);
    }

    function _signNativeAuthorization(
        bytes32 accountID,
        uint64 credentialID,
        uint256 nonce,
        uint40 expiration,
        uint8 mutation,
        bytes memory mutationData,
        uint256 privateKey
    ) internal returns (Authorization memory authorization) {
        authorization = Authorization({
            accountID: accountID, credentialID: credentialID, nonce: nonce, expiration: expiration, signature: bytes("")
        });
        bytes32 authorizationDigest = nativeHarness.authorizationDigest(authorization, mutation, mutationData);
        authorization.signature = _signSecp256k1(privateKey, authorizationDigest);
    }

    function _executeNative(uint8 mutation, bytes memory mutationData, Authorization memory authorization) internal {
        _settle(_nativeBatch(mutation, mutationData, authorization), EXECUTOR_ID, EXECUTOR_PK);
    }

    function _expectNativeRevert(
        uint8 mutation,
        bytes memory mutationData,
        Authorization memory authorization,
        bytes memory expectedRevert
    ) internal {
        _expectSettleRevert(
            _nativeBatch(mutation, mutationData, authorization), EXECUTOR_ID, EXECUTOR_PK, expectedRevert
        );
    }

    /// Settles `batch` from this contract, signed by `privateKey` as scheduler credential `credentialID`.
    function _settle(Typewriter.Batch memory batch, uint64 credentialID, uint256 privateKey) internal {
        (bool ok, bytes memory ret) = _callSettle(batch, credentialID, privateKey);
        _bubble(ok, ret);
    }

    function _expectSettleRevert(
        Typewriter.Batch memory batch,
        uint64 credentialID,
        uint256 privateKey,
        bytes memory expectedRevert
    ) internal {
        (bool ok, bytes memory ret) = _callSettle(batch, credentialID, privateKey);
        require(!ok, "expected settlement to revert");
        require(keccak256(ret) == keccak256(expectedRevert), "wrong settlement revert");
    }

    function _callSettle(Typewriter.Batch memory batch, uint64 credentialID, uint256 privateKey)
        internal
        returns (bool, bytes memory)
    {
        bytes32 fromExecutionHash = nativeHarness.executionHash();
        bytes memory signature =
            _signExecute(privateKey, fromExecutionHash, _accumulate(fromExecutionHash, batch), address(this));
        return address(nativeHarness)
            .call(
                abi.encodeCall(
                    nativeHarness.execute,
                    (
                        fromExecutionHash,
                        uint40(block.timestamp),
                        batch,
                        new uint256[](0),
                        SchedulerAuthorization(credentialID, signature)
                    )
                )
            );
    }

    function _signExecute(uint256 privateKey, bytes32 fromExecutionHash, bytes32 toExecutionHash, address relayer)
        internal
        returns (bytes memory)
    {
        return _signSecp256k1(
            privateKey,
            nativeHarness.executeDigest(fromExecutionHash, toExecutionHash, uint40(block.timestamp), relayer)
        );
    }

    /// `executionHash` after `batch` executes from `hash`, as `Typewriter._accumulate` computes it.
    function _accumulate(bytes32 hash, Typewriter.Batch memory batch) internal pure returns (bytes32) {
        for (uint256 i; i < batch.mutations.length; i++) {
            hash = _accumulate(hash, batch.mutations[i], batch.mutationData[i], batch.authorizationData[i]);
        }
        return hash;
    }

    function _accumulate(bytes32 hash, uint8 mutation, bytes memory mutationData, bytes memory authorizationData)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(hash, mutation, keccak256(mutationData), keccak256(authorizationData)));
    }

    function _nativeBatch(uint8 mutation, bytes memory mutationData, Authorization memory authorization)
        internal
        pure
        returns (Typewriter.Batch memory batch)
    {
        batch.mutations = new uint8[](1);
        batch.mutationData = new bytes[](1);
        batch.authorizationData = new bytes[](1);
        batch.mutations[0] = mutation;
        batch.mutationData[0] = mutationData;
        batch.authorizationData[0] = abi.encode(authorization);
    }

    function _emptyBatch() internal pure returns (Typewriter.Batch memory batch) {}
}
