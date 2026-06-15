import type { FFCAConfig, FFCAMutationInput } from "ffca";
import {
  encodeAbiParameters,
  type Hex,
  parseAbiParameters,
  parseSignature,
} from "viem";

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

export const ORDER_BOOK_SIGNATURE_PARAMS = parseAbiParameters(
  "bytes32 account, uint64 keyId, bytes rawSignature",
);

export const ORDER_BOOK_MUTATIONS = {
  Initialize: {
    tag: 0,
    params: parseAbiParameters(
      "bytes32 account, uint40 expiry, uint8 rootKeyType, uint8 keyType, uint16 permissions, bytes rootPublicKey, bytes publicKey",
    ),
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
    tag: 1,
    params: parseAbiParameters(
      "bytes32 account, uint40 expiry, uint8 keyType, uint16 permissions, bytes publicKey, uint256 nonce, uint256 deadline",
    ),
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
    tag: 2,
    params: parseAbiParameters(
      "bytes32 account, uint64 keyId, uint256 nonce, uint256 deadline",
    ),
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
    tag: 3,
    params: parseAbiParameters(
      "uint64 orderId, uint256 nonce, uint256 deadline",
    ),
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
    tag: 4,
    params: parseAbiParameters(
      "uint64 orderId, uint64 price, uint256 nonce, uint256 deadline",
    ),
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
    tag: 5,
    params: parseAbiParameters(
      "uint256 quantity, uint64 instrumentId, uint64 price, uint8 bidOrAsk, uint256 nonce, uint256 deadline",
    ),
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
    tag: 6,
    params: parseAbiParameters(
      "uint256 quantity, uint256 minReceivedQuantity, uint64 instrumentId, uint8 bidOrAsk, uint256 nonce, uint256 deadline",
    ),
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
    tag: 7,
    params: parseAbiParameters(
      "uint64 instrumentId, address base, address quote, uint8 baseLotExp, uint8 quoteLotExp, uint256 nonce, uint256 deadline",
    ),
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
    tag: 8,
    params: parseAbiParameters(
      "address asset, uint256 amount, uint256 nonce, uint256 deadline",
    ),
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
    tag: 9,
    params: parseAbiParameters(
      "address asset, uint256 amount, uint256 nonce, uint256 deadline",
    ),
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
} as const satisfies FFCAConfig["mutations"];

export type SubmittedOrderBookMutation = FFCAMutationInput<
  typeof ORDER_BOOK_MUTATIONS,
  typeof ORDER_BOOK_SIGNATURE_PARAMS
>;

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
