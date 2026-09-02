// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    ADD_CREDENTIAL_MUTATION,
    AUTHORIZATION_TYPEHASH,
    CREATE_ACCOUNT_MUTATION,
    EIP712_DOMAIN_TYPEHASH,
    REMOVE_CREDENTIAL_MUTATION,
    Account,
    AddCredential,
    Authorization,
    AuthorizationExpired,
    CreateAccount,
    Credential,
    CredentialExpired,
    CredentialNotFound,
    InvalidCreateAuthorization,
    InvalidNonce,
    InvalidSignature,
    KeyType,
    LastCredential,
    NonceOverflow,
    PermissionDenied,
    RemoveCredential,
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

    constructor() {
        SCHEDULER = msg.sender;
        FORCE_INCLUSION_DELAY = 2;
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID) internal override {
        if (mutation != SET_VALUE_MUTATION) revert UnknownMutation(mutation);
        SetValue memory setValue = abi.decode(mutationData, (SetValue));
        value = setValue.value;
        lastAccountID = accountID;
    }

    function authorizationDigest(Authorization calldata authorization, uint8 mutation, bytes calldata mutationData)
        external
        view
        returns (bytes32)
    {
        return _authorizationDigest(authorization, mutation, mutationData);
    }

    function domainSeparator() external view returns (bytes32) {
        return DOMAIN_SEPARATOR;
    }

    function accountState(bytes32 accountID) external view returns (uint256 credentialCount, uint64 activeCredentials) {
        Account storage account = accounts[accountID];
        return (account.credentials.length, account.activeCredentials);
    }

    function credential(bytes32 accountID, uint64 credentialID)
        external
        view
        returns (uint40 expiration, KeyType keyType, uint256 permissions, bytes memory publicKey)
    {
        Credential storage stored = accounts[accountID].credentials[credentialID];
        return (stored.expiration, stored.keyType, stored.permissions, stored.publicKey);
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

    function setUp() public {
        harness = new AccountHarness();
        nativeHarness = new NativeAccountHarness();
    }

    function test_verifySignature_acceptsSecp256k1() external {
        harness.verifySignatureExternal(
            KeyType.Secp256k1, DIGEST, _secp256k1PublicKey(SECP256K1_PK), _signSecp256k1(SECP256K1_PK, DIGEST)
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
            AUTHORIZATION_TYPEHASH == 0x5f92272600e6b6e2e16927f57bb0242c9554f04db37b30f3bda043f854d5d40d,
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
            (uint256 credentialCount, uint64 activeCredentials) = nativeHarness.accountState(accountID);
            require(credentialCount == 1 && activeCredentials == 1, "root account state");
            (uint40 rootExpiration, KeyType rootKeyType, uint256 rootPermissions, bytes memory rootPublicKey) =
                nativeHarness.credential(accountID, 0);
            require(rootExpiration == 0, "root expiration");
            require(rootKeyType == KeyType.Secp256k1, "root key type");
            require(rootPermissions == type(uint256).max, "root permissions");
            require(keccak256(rootPublicKey) == keccak256(_secp256k1PublicKey(SECP256K1_PK)), "root public key");
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
            (uint256 credentialCount, uint64 activeCredentials) = nativeHarness.accountState(accountID);
            require(credentialCount == 2 && activeCredentials == 2, "added credential");
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
            (uint256 credentialCount, uint64 activeCredentials) = nativeHarness.accountState(accountID);
            require(credentialCount == 2 && activeCredentials == 1, "removed credential");
            (,,, bytes memory removedPublicKey) = nativeHarness.credential(accountID, 1);
            require(removedPublicKey.length == 0, "deleted credential");
        }

        {
            Authorization memory addAuthorization = _signNativeAuthorization(
                accountID, 0, 2, 0, ADD_CREDENTIAL_MUTATION, abi.encode(addCredential), SECP256K1_PK
            );
            _executeNative(ADD_CREDENTIAL_MUTATION, abi.encode(addCredential), addAuthorization);
        }

        {
            (uint256 credentialCount, uint64 activeCredentials) = nativeHarness.accountState(accountID);
            require(credentialCount == 3 && activeCredentials == 2, "stable credential ID");
            (,,, bytes memory appendedPublicKey) = nativeHarness.credential(accountID, 2);
            require(appendedPublicKey.length != 0, "appended credential");
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
            abi.encodeWithSelector(LastCredential.selector, accountID)
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
        Typewriter.Batch[] memory batches = new Typewriter.Batch[](0);
        uint256[] memory forceExecuteIndexes = new uint256[](1);
        forceExecuteIndexes[0] = queuedIndex;

        nativeHarness.execute(batches, forceExecuteIndexes);

        require(nativeHarness.value() == 55, "queued dispatch");
        require(nativeHarness.nonce(accountID, 0) == 1, "queued nonce");
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
        return abi.encode(v, r, s);
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
        uint256 expiration,
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
        Typewriter.Batch[] memory batches = _nativeBatch(mutation, mutationData, authorization);
        uint256[] memory forceExecuteIndexes = new uint256[](0);
        nativeHarness.execute(batches, forceExecuteIndexes);
    }

    function _expectNativeRevert(
        uint8 mutation,
        bytes memory mutationData,
        Authorization memory authorization,
        bytes memory expectedRevert
    ) internal {
        Typewriter.Batch[] memory batches = _nativeBatch(mutation, mutationData, authorization);
        uint256[] memory forceExecuteIndexes = new uint256[](0);
        (bool ok, bytes memory ret) = address(nativeHarness)
            .call(abi.encodeWithSelector(nativeHarness.execute.selector, batches, forceExecuteIndexes));
        require(!ok, "expected native execution to revert");
        require(keccak256(ret) == keccak256(expectedRevert), "wrong native revert");
    }

    function _nativeBatch(uint8 mutation, bytes memory mutationData, Authorization memory authorization)
        internal
        pure
        returns (Typewriter.Batch[] memory batches)
    {
        batches = new Typewriter.Batch[](1);
        batches[0].mutations = new uint8[](1);
        batches[0].mutationData = new bytes[](1);
        batches[0].authorizationData = new bytes[](1);
        batches[0].mutations[0] = mutation;
        batches[0].mutationData[0] = mutationData;
        batches[0].authorizationData[0] = abi.encode(authorization);
    }
}
