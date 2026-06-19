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
  },
  Authorize: {
    tag: 1,
    params: parseAbiParameters(
      "bytes32 account, uint40 expiry, uint8 keyType, uint16 permissions, bytes publicKey, uint256 nonce, uint256 deadline",
    ),
  },
  Revoke: {
    tag: 2,
    params: parseAbiParameters(
      "bytes32 account, uint64 keyId, uint256 nonce, uint256 deadline",
    ),
  },
  CloseOrder: {
    tag: 3,
    params: parseAbiParameters(
      "uint64 orderId, uint256 nonce, uint256 deadline",
    ),
  },
  ChangeOrder: {
    tag: 4,
    params: parseAbiParameters(
      "uint64 orderId, uint64 price, uint256 nonce, uint256 deadline",
    ),
  },
  LimitOrder: {
    tag: 5,
    params: parseAbiParameters(
      "uint256 quantity, uint64 instrumentId, uint64 price, uint8 bidOrAsk, uint256 nonce, uint256 deadline",
    ),
  },
  MarketOrder: {
    tag: 6,
    params: parseAbiParameters(
      "uint256 quantity, uint256 minReceivedQuantity, uint64 instrumentId, uint8 bidOrAsk, uint256 nonce, uint256 deadline",
    ),
  },
  AddInstrument: {
    tag: 7,
    params: parseAbiParameters(
      "uint64 instrumentId, address base, address quote, uint8 baseLotExp, uint8 quoteLotExp, uint256 nonce, uint256 deadline",
    ),
  },
  Deposit: {
    tag: 8,
    params: parseAbiParameters(
      "address asset, uint256 amount, uint256 nonce, uint256 deadline",
    ),
  },
  Withdrawal: {
    tag: 9,
    params: parseAbiParameters(
      "address asset, uint256 amount, uint256 nonce, uint256 deadline",
    ),
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
