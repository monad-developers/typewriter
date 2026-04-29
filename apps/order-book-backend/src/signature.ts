import { EIP712_TYPES } from "order-book-sdk";
import * as P256 from "ox/P256";
import * as PublicKey from "ox/PublicKey";
import * as WebAuthnP256 from "ox/WebAuthnP256";
import type { Address, Hex } from "viem";
import {
  decodeAbiParameters,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toHex,
} from "viem";
import type { State, TaggedMutation } from "./exchange";
import { getAccount, getNonceSeq, MutationType } from "./exchange";

export type EIP712Domain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
  rpId?: string;
  origin?: string | string[];
};

export function getTypedDataParams(mutation: TaggedMutation): {
  primaryType: string;
  message: Record<string, unknown>;
} {
  switch (mutation.type) {
    case MutationType.Initialize:
      return {
        primaryType: "Initialize",
        message: {
          account: mutation.account,
          expiry: mutation.mutation.expiry,
          rootKeyType: mutation.mutation.rootKeyType,
          keyType: mutation.mutation.keyType,
          permissions: mutation.mutation.permissions,
          rootPublicKey: mutation.mutation.rootPublicKey,
          publicKey: mutation.mutation.publicKey,
        },
      };
    case MutationType.Authorize:
      return {
        primaryType: "Authorize",
        message: {
          account: mutation.account,
          expiry: mutation.mutation.expiry,
          keyType: mutation.mutation.keyType,
          permissions: mutation.mutation.permissions,
          publicKey: mutation.mutation.publicKey,
          nonce: mutation.nonce,
          deadline: mutation.deadline,
        },
      };
    case MutationType.Revoke:
      return {
        primaryType: "Revoke",
        message: {
          account: mutation.account,
          keyId: BigInt(mutation.mutation.keyId),
          nonce: mutation.nonce,
          deadline: mutation.deadline,
        },
      };
    case MutationType.CloseOrder:
      return {
        primaryType: "CloseOrder",
        message: {
          orderId: BigInt(mutation.mutation.orderId),
          nonce: mutation.nonce,
          deadline: mutation.deadline,
        },
      };
    case MutationType.LimitOrder:
      return {
        primaryType: "LimitOrder",
        message: {
          quantity: mutation.mutation.quantity,
          instrumentId: BigInt(mutation.mutation.instrumentId),
          price: mutation.mutation.price,
          bidOrAsk: mutation.mutation.bidOrAsk,
          nonce: mutation.nonce,
          deadline: mutation.deadline,
        },
      };
    case MutationType.MarketOrder:
      return {
        primaryType: "MarketOrder",
        message: {
          quantity: mutation.mutation.quantity,
          minReceivedQuantity: mutation.mutation.minReceivedQuantity,
          instrumentId: BigInt(mutation.mutation.instrumentId),
          bidOrAsk: mutation.mutation.bidOrAsk,
          nonce: mutation.nonce,
          deadline: mutation.deadline,
        },
      };
    case MutationType.AddInstrument:
      return {
        primaryType: "AddInstrument",
        message: {
          instrumentId: BigInt(mutation.mutation.instrumentId),
          base: mutation.mutation.base,
          quote: mutation.mutation.quote,
          baseLotExp: mutation.mutation.baseLotExp,
          quoteLotExp: mutation.mutation.quoteLotExp,
          nonce: mutation.nonce,
          deadline: mutation.deadline,
        },
      };
    case MutationType.Deposit:
      return {
        primaryType: "Deposit",
        message: {
          asset: mutation.mutation.asset,
          amount: mutation.mutation.amount,
          nonce: mutation.nonce,
          deadline: mutation.deadline,
        },
      };
    case MutationType.Withdrawal:
      return {
        primaryType: "Withdrawal",
        message: {
          asset: mutation.mutation.asset,
          amount: mutation.mutation.amount,
          nonce: mutation.nonce,
          deadline: mutation.deadline,
        },
      };
  }
}

export async function verifySignature(
  state: State<bigint>,
  eip712Domain: EIP712Domain,
  mutation: TaggedMutation,
): Promise<void> {
  if (mutation.type === MutationType.Initialize) {
    const expected = keccak256(mutation.mutation.rootPublicKey);
    if (mutation.account.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `InvalidAccount: account=${mutation.account}, expected=${expected}`,
      );
    }
    return;
  }

  if (mutation.deadline < BigInt(Math.floor(Date.now() / 1000))) {
    throw new Error(
      `SignatureExpired: deadline=${mutation.deadline}, now=${Math.floor(Date.now() / 1000)}, account=${mutation.account}`,
    );
  }

  const acc = getAccount(state, mutation.account);
  const key = acc.keys[mutation.keyId];
  if (!key || key.permissions === 0) {
    throw new Error(
      `KeyNotFound: account=${mutation.account}, keyId=${mutation.keyId}`,
    );
  }
  if (key.expiry !== 0 && key.expiry < Math.floor(Date.now() / 1000)) {
    throw new Error(
      `KeyExpired: account=${mutation.account}, keyId=${mutation.keyId}, expiry=${key.expiry}, now=${Math.floor(Date.now() / 1000)}`,
    );
  }
  const nonceKey = BigInt(mutation.nonce) >> 64n;
  const nonceSeq = BigInt(mutation.nonce) & 0xffffffffffffffffn;
  if (nonceSeq !== getNonceSeq(acc, nonceKey)) {
    throw new Error(
      `InvalidNonce: account=${mutation.account}, expected=${getNonceSeq(acc, nonceKey)}, got=${nonceSeq}, nonceKey=${toHex(nonceKey)}`,
    );
  }

  const { primaryType, message } = getTypedDataParams(mutation);
  const typedData = {
    domain: eip712Domain,
    types: EIP712_TYPES,
    primaryType,
    message,
  } as Parameters<typeof hashTypedData>[0];

  switch (key.keyType) {
    case 0: {
      const hash = hashTypedData(typedData);
      const [r, s] = decodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }],
        mutation.rawSignature,
      );
      const publicKey = PublicKey.from(key.publicKey as `0x${string}`);
      if (
        P256.verify({
          payload: hash,
          publicKey,
          signature: { r, s },
          hash: true,
        }) === false
      ) {
        throw new Error(
          `InvalidSignature: P256 verification failed, account=${mutation.account}, publicKey=${key.publicKey}, hash=${hash}`,
        );
      }
      break;
    }
    case 1: {
      const hash = hashTypedData(typedData);
      const [authenticatorData, clientDataJSON, _challengeOffset, r, s] =
        decodeAbiParameters(
          [
            { type: "bytes" },
            { type: "string" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint256" },
          ],
          mutation.rawSignature,
        );
      const publicKey = PublicKey.from(key.publicKey as `0x${string}`);
      const clientData = JSON.parse(clientDataJSON) as { origin: string };
      const clientOrigin = clientData.origin;
      const clientRpId = new URL(clientOrigin).hostname;
      if (
        WebAuthnP256.verify({
          challenge: hash,
          publicKey,
          signature: { r, s },
          metadata: {
            authenticatorData: authenticatorData as Hex,
            clientDataJSON,
          },
          rpId: eip712Domain.rpId ?? clientRpId,
          origin: eip712Domain.origin ?? clientOrigin,
        }) === false
      ) {
        throw new Error(
          `InvalidSignature: WebAuthn verification failed, account=${mutation.account}, rpId=${eip712Domain.rpId ?? clientRpId}, origin=${eip712Domain.origin ?? clientOrigin}, publicKey=${key.publicKey}`,
        );
      }
      break;
    }
    case 2: {
      const recovered = await recoverTypedDataAddress({
        ...typedData,
        signature: mutation.rawSignature,
      });
      const expectedAddress = `0x${key.publicKey.toLowerCase().slice(26)}`;
      if (recovered.toLowerCase() !== expectedAddress) {
        throw new Error(
          `InvalidSignature: secp256k1 recovery mismatch, account=${mutation.account}, recovered=${recovered}, expected=${expectedAddress}`,
        );
      }
      break;
    }
    default:
      throw new Error(
        `InvalidSignature: unknown keyType=${key.keyType}, account=${mutation.account}`,
      );
  }
}
