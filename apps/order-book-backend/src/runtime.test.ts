import { expect, test } from "bun:test";
import * as P256 from "ox/P256";
import * as PublicKey from "ox/PublicKey";
import { Authentication } from "ox/webauthn";
import type { Address, Hex } from "viem";
import { encodeAbiParameters, hashTypedData } from "viem";
import { privateKeyToAccount, signTypedData } from "viem/accounts";
import { anvil } from "viem/chains";
import { createState, MutationType } from "./exchange";
import { type EIP712Domain, verifySignature } from "./runtime";

const EXCHANGE_ADDRESS =
  "0x0000000000000000000000000000000000000000" as Address;
const BASE: Address = "0x1111111111111111111111111111111111111111";
const FAR_DEADLINE = BigInt(
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
);

const EIP712_DOMAIN: EIP712Domain = {
  name: "Exchange",
  version: "1",
  chainId: anvil.id,
  verifyingContract: EXCHANGE_ADDRESS,
  rpId: "example.com",
  origin: "https://example.com",
};

const EIP712_TYPES = {
  Deposit: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

test("verifySignature secp256k1", async () => {
  const pk =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
  const wallet = privateKeyToAccount(pk);
  const accountId =
    `0x000000000000000000000000${wallet.address.slice(2).toLowerCase()}` as Hex;

  const state = createState();
  state.accounts[accountId] = {
    nonces: {},
    balances: {},
    keys: [
      {
        expiry: 0,
        keyType: 2,
        permissions: 0x7f,
        publicKey:
          `0x000000000000000000000000${wallet.address.slice(2).toLowerCase()}` as Hex,
      },
    ],
    orders: [],
  };

  const rawSignature = await signTypedData({
    privateKey: pk,
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: {
      asset: BASE,
      amount: 1000n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });

  await verifySignature(state, EIP712_DOMAIN, {
    type: MutationType.Deposit,
    account: accountId,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature,
    mutation: { asset: BASE, amount: 1000n },
  });
});

test("verifySignature p256", async () => {
  const { privateKey, publicKey } = P256.createKeyPair();
  const publicKeyHex = PublicKey.toHex(publicKey) as Hex;
  const accountId =
    "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex;

  const state = createState();
  state.accounts[accountId] = {
    nonces: {},
    balances: {},
    keys: [
      {
        expiry: 0,
        keyType: 0,
        permissions: 0x7f,
        publicKey: publicKeyHex,
      },
    ],
    orders: [],
  };

  const hash = hashTypedData({
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: {
      asset: BASE,
      amount: 1000n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });

  const signature = P256.sign({ payload: hash, privateKey, hash: true });
  const rawSignature = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    [signature.r, signature.s],
  );

  await verifySignature(state, EIP712_DOMAIN, {
    type: MutationType.Deposit,
    account: accountId,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature,
    mutation: { asset: BASE, amount: 1000n },
  });
});

test("verifySignature webauthn", async () => {
  const { privateKey, publicKey } = P256.createKeyPair();
  const publicKeyHex = PublicKey.toHex(publicKey) as Hex;
  const accountId =
    "0x0000000000000000000000000000000000000000000000000000000000000002" as Hex;

  const state = createState();
  state.accounts[accountId] = {
    nonces: {},
    balances: {},
    keys: [
      {
        expiry: 0,
        keyType: 1,
        permissions: 0x7f,
        publicKey: publicKeyHex,
      },
    ],
    orders: [],
  };

  const challenge = hashTypedData({
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: {
      asset: BASE,
      amount: 1000n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });

  const { metadata, payload } = Authentication.getSignPayload({
    challenge,
    origin: "https://example.com",
    rpId: "example.com",
  });

  const signature = P256.sign({ payload, privateKey, hash: true });
  const rawSignature = encodeAbiParameters(
    [
      { type: "bytes" },
      { type: "string" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [
      metadata.authenticatorData as Hex,
      metadata.clientDataJSON,
      signature.r,
      signature.s,
    ],
  );

  await verifySignature(state, EIP712_DOMAIN, {
    type: MutationType.Deposit,
    account: accountId,
    keyId: 0,
    nonce: 0n,
    deadline: FAR_DEADLINE,
    rawSignature,
    mutation: { asset: BASE, amount: 1000n },
  });
});

test("wrong secp256k1 signer rejects", async () => {
  const signerPk =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
  const otherWallet = privateKeyToAccount(
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  );
  const accountId =
    `0x000000000000000000000000${otherWallet.address.slice(2).toLowerCase()}` as Hex;

  const state = createState();
  state.accounts[accountId] = {
    nonces: {},
    balances: {},
    keys: [
      {
        expiry: 0,
        keyType: 2,
        permissions: 0x7f,
        publicKey:
          `0x000000000000000000000000${otherWallet.address.slice(2).toLowerCase()}` as Hex,
      },
    ],
    orders: [],
  };

  const rawSignature = await signTypedData({
    privateKey: signerPk,
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: {
      asset: BASE,
      amount: 1000n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });

  await expect(
    verifySignature(state, EIP712_DOMAIN, {
      type: MutationType.Deposit,
      account: accountId,
      keyId: 0,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature,
      mutation: { asset: BASE, amount: 1000n },
    }),
  ).rejects.toThrow("InvalidSignature");
});

test("wrong p256 key rejects", async () => {
  const { privateKey } = P256.createKeyPair();
  const { publicKey: wrongPublicKey } = P256.createKeyPair();
  const publicKeyHex = PublicKey.toHex(wrongPublicKey) as Hex;
  const accountId =
    "0x0000000000000000000000000000000000000000000000000000000000000003" as Hex;

  const state = createState();
  state.accounts[accountId] = {
    nonces: {},
    balances: {},
    keys: [
      {
        expiry: 0,
        keyType: 0,
        permissions: 0x7f,
        publicKey: publicKeyHex,
      },
    ],
    orders: [],
  };

  const hash = hashTypedData({
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: {
      asset: BASE,
      amount: 1000n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });

  const signature = P256.sign({ payload: hash, privateKey, hash: true });
  const rawSignature = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    [signature.r, signature.s],
  );

  await expect(
    verifySignature(state, EIP712_DOMAIN, {
      type: MutationType.Deposit,
      account: accountId,
      keyId: 0,
      nonce: 0n,
      deadline: FAR_DEADLINE,
      rawSignature,
      mutation: { asset: BASE, amount: 1000n },
    }),
  ).rejects.toThrow("InvalidSignature");
});
