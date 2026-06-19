import type { FFCAMutationConfig } from "ffca";
import { encodeAbiParameters, type Hex, parseSignature } from "viem";

export type OrderBookSignature = {
  account: Hex;
  keyId: bigint;
  rawSignature: Hex;
};

const instrumentAssets = new Map<bigint, { base: Hex; quote: Hex }>();

export const ORDER_BOOK_BATCH_ORDER = [
  "Initialize",
  "Authorize",
  "Revoke",
  "CloseOrder",
  "ChangeOrder",
  "LimitOrder",
  "MarketOrder",
  "AddInstrument",
  "Deposit",
  "Withdrawal",
] as const;

export const ORDER_BOOK_MUTATIONS = {
  Initialize: {
    registerMappingKeys: ({ signature }) => {
      const { account } = signature as OrderBookSignature;
      return [
        `accounts[${account}].keys`,
        `accounts[${account}].keys[0].expiry`,
        `accounts[${account}].keys[0].keyType`,
        `accounts[${account}].keys[0].permissions`,
        `accounts[${account}].keys[0].publicKey`,
        `accounts[${account}].keys[1].expiry`,
        `accounts[${account}].keys[1].keyType`,
        `accounts[${account}].keys[1].permissions`,
        `accounts[${account}].keys[1].publicKey`,
      ];
    },
  },
  Authorize: {
    registerMappingKeys: ({ params, signature }) => {
      const { nonce } = params as Record<string, bigint>;
      const { account } = signature as OrderBookSignature;
      return [
        `accounts[${account}].keys`,
        `accounts[${account}].nonces[${BigInt(nonce) >> 64n}]`,
      ];
    },
  },
  Revoke: {
    registerMappingKeys: ({ params, signature }) => {
      const { keyId, nonce } = params as Record<string, bigint>;
      const { account } = signature as OrderBookSignature;
      return [
        `accounts[${account}].nonces[${BigInt(nonce) >> 64n}]`,
        `accounts[${account}].keys[${keyId}].expiry`,
        `accounts[${account}].keys[${keyId}].keyType`,
        `accounts[${account}].keys[${keyId}].permissions`,
        `accounts[${account}].keys[${keyId}].publicKey`,
      ];
    },
  },
  CloseOrder: {
    registerMappingKeys: ({ params, signature }) => {
      const { nonce, orderId } = params as Record<string, bigint>;
      const { account } = signature as OrderBookSignature;
      return [
        `accounts[${account}].nonces[${BigInt(nonce) >> 64n}]`,
        `accounts[${account}].orders[${orderId}].quantity`,
      ];
    },
  },
  ChangeOrder: {
    registerMappingKeys: ({ params, signature }) => {
      const { nonce, orderId } = params as Record<string, bigint>;
      const { account } = signature as OrderBookSignature;
      return [
        `accounts[${account}].nonces[${BigInt(nonce) >> 64n}]`,
        `accounts[${account}].orders[${orderId}].quantity`,
      ];
    },
  },
  LimitOrder: {
    registerMappingKeys: ({ params, signature }) => {
      const { bidOrAsk, instrumentId, nonce, price } = params as Record<
        string,
        bigint | number
      >;
      const { account } = signature as OrderBookSignature;
      const side = bidOrAsk === 0 ? "bids" : "asks";
      return [
        `accounts[${account}].nonces[${BigInt(nonce) >> 64n}]`,
        `instruments[${instrumentId}].${side}[${price}].quantity`,
        `instruments[${instrumentId}].${side}[${price}].remainingQuantity`,
        `instruments[${instrumentId}].${side}[${price}].volume`,
      ];
    },
  },
  MarketOrder: {
    registerMappingKeys: ({ params, signature }) => {
      const { instrumentId, nonce } = params as Record<string, bigint>;
      const { account } = signature as OrderBookSignature;
      const assets = instrumentAssets.get(BigInt(instrumentId));
      const paths = [`accounts[${account}].nonces[${BigInt(nonce) >> 64n}]`];
      if (assets !== undefined) {
        paths.push(
          `accounts[${account}].balances[${assets.base}]`,
          `accounts[${account}].balances[${assets.quote}]`,
        );
      }
      return paths;
    },
  },
  AddInstrument: {
    registerMappingKeys: ({ params, signature }) => {
      const { base, quote } = params as Record<string, Hex>;
      const { instrumentId, nonce } = params as Record<string, bigint>;
      const { account } = signature as OrderBookSignature;
      instrumentAssets.set(BigInt(instrumentId), { base, quote });
      return [
        `accounts[${account}].nonces[${BigInt(nonce) >> 64n}]`,
        `instruments[${instrumentId}].base`,
        `instruments[${instrumentId}].quote`,
        `instruments[${instrumentId}].baseLotExp`,
        `instruments[${instrumentId}].quoteLotExp`,
        `instruments[${instrumentId}].bestBid`,
        `instruments[${instrumentId}].bestAsk`,
      ];
    },
  },
  Deposit: {
    registerMappingKeys: ({ params, signature }) => {
      const { asset } = params as Record<string, Hex>;
      const { nonce } = params as Record<string, bigint>;
      const { account } = signature as OrderBookSignature;
      return [
        `accounts[${account}].nonces[${BigInt(nonce) >> 64n}]`,
        `accounts[${account}].balances[${asset}]`,
      ];
    },
  },
  Withdrawal: {
    registerMappingKeys: ({ params, signature }) => {
      const { asset } = params as Record<string, Hex>;
      const { nonce } = params as Record<string, bigint>;
      const { account } = signature as OrderBookSignature;
      return [
        `accounts[${account}].nonces[${BigInt(nonce) >> 64n}]`,
        `accounts[${account}].balances[${asset}]`,
      ];
    },
  },
} as const satisfies Record<string, FFCAMutationConfig>;

export type SubmittedOrderBookMutation<name extends string = string> = {
  name: name;
  params: Record<string, unknown>;
  signature: OrderBookSignature;
};

export function normalizeSignatureForContract(
  signature: OrderBookSignature,
): OrderBookSignature {
  const rawSignature =
    signature.rawSignature.length === 132
      ? (() => {
          const { v, r, s } = parseSignature(signature.rawSignature);
          return encodeAbiParameters(
            [{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
            [Number(v), r, s],
          );
        })()
      : signature.rawSignature;

  return {
    ...signature,
    rawSignature,
  };
}
