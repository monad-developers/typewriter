import type { FFCAConfig } from "ffca";
import type { EXCHANGE_STORAGE_LAYOUT } from "order-book-sdk";
import type { StorageProxy } from "storage-layout";
import {
  encodeAbiParameters,
  type Hex,
  parseAbiParameters,
  parseSignature,
} from "viem";
import {
  type AddInstrument,
  type Authorize,
  type ChangeOrder,
  type CloseOrder,
  type Deposit,
  type Initialize,
  type LimitOrder,
  type MarketOrder,
  type MarketOrderResolution,
  MutationType,
  type Revoke,
  type Withdrawal,
} from "./exchange";

type OrderBookStorage = StorageProxy<typeof EXCHANGE_STORAGE_LAYOUT, true>;

export type OrderBookSignature = {
  account: Hex;
  keyId: bigint;
  rawSignature: Hex;
};

type AccountParam = { account: Hex };
type SignedParams = { nonce: bigint; deadline: bigint };

export type InitializeParams = Initialize & AccountParam;
export type AuthorizeParams = Authorize & AccountParam & SignedParams;
export type RevokeParams = Omit<Revoke, "keyId"> &
  AccountParam &
  SignedParams & { keyId: bigint };
export type CloseOrderParams = CloseOrder & SignedParams;
export type ChangeOrderParams = ChangeOrder<bigint> & SignedParams;
export type LimitOrderParams = LimitOrder<bigint> & SignedParams;
export type MarketOrderParams = MarketOrder<bigint> & SignedParams;
export type AddInstrumentParams = AddInstrument & SignedParams;
export type DepositParams = Deposit<bigint> & SignedParams;
export type WithdrawalParams = Withdrawal<bigint> & SignedParams;

export type OrderBookMutationName =
  | "Initialize"
  | "Authorize"
  | "Revoke"
  | "CloseOrder"
  | "ChangeOrder"
  | "LimitOrder"
  | "MarketOrder"
  | "AddInstrument"
  | "Deposit"
  | "Withdrawal";

type OrderBookMutationParamsByName = {
  Initialize: InitializeParams;
  Authorize: AuthorizeParams;
  Revoke: RevokeParams;
  CloseOrder: CloseOrderParams;
  ChangeOrder: ChangeOrderParams;
  LimitOrder: LimitOrderParams;
  MarketOrder: MarketOrderParams;
  AddInstrument: AddInstrumentParams;
  Deposit: DepositParams;
  Withdrawal: WithdrawalParams;
};

export type SubmittedOrderBookMutation = {
  [name in OrderBookMutationName]: {
    name: name;
    params: OrderBookMutationParamsByName[name];
    signature: OrderBookSignature;
  };
}[OrderBookMutationName];

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

async function resolveMarket(
  storage: OrderBookStorage,
  params: MarketOrderParams,
): Promise<MarketOrderResolution<bigint>> {
  const instrument =
    storage.instruments[String(params.instrumentId) as `${number}`];
  const opposingSide =
    params.bidOrAsk === 0 ? instrument.asks : instrument.bids;
  const prices = Object.keys(opposingSide)
    .map(Number)
    .sort((a, b) => (params.bidOrAsk === 0 ? a - b : b - a));
  const baseLotExp = await instrument.baseLotExp;
  const fills: { quantity: bigint; price: bigint }[] = [];
  const quantityLots = params.quantity >> BigInt(baseLotExp);
  let remaining = quantityLots;

  for (const price of prices) {
    if (remaining <= 0n) break;
    const tick = opposingSide[String(price) as `${number}`];
    const available = await tick.remainingQuantity;
    if (available <= 0n) continue;

    const quantity = remaining < available ? remaining : available;
    fills.push({ quantity, price: BigInt(price) });
    remaining -= quantity;
  }

  if (remaining > 0n) {
    throw new Error(
      `InsufficientLiquidity: resolveMarket totalFilled=${quantityLots - remaining} quantityLots=${quantityLots} fillCount=${fills.length} instrumentId=${params.instrumentId}`,
    );
  }

  return { fills };
}

export const ORDER_BOOK_MUTATIONS = {
  Initialize: {
    tag: MutationType.Initialize,
    params: parseAbiParameters(
      "bytes32 account, uint40 expiry, uint8 rootKeyType, uint8 keyType, uint16 permissions, bytes rootPublicKey, bytes publicKey",
    ),
    registerMappingKeys: ({ signature }) => {
      const { account } = signature as OrderBookSignature;
      return [
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
    tag: MutationType.Authorize,
    params: parseAbiParameters(
      "bytes32 account, uint40 expiry, uint8 keyType, uint16 permissions, bytes publicKey, uint256 nonce, uint256 deadline",
    ),
    registerMappingKeys: ({ params, signature }) => {
      const { nonce } = params as AuthorizeParams;
      const { account } = signature as OrderBookSignature;
      return [`accounts[${account}].nonces[${nonce >> 64n}]`];
    },
  },
  Revoke: {
    tag: MutationType.Revoke,
    params: parseAbiParameters(
      "bytes32 account, uint64 keyId, uint256 nonce, uint256 deadline",
    ),
    registerMappingKeys: ({ params, signature }) => {
      const { keyId, nonce } = params as RevokeParams;
      const { account } = signature as OrderBookSignature;
      return [
        `accounts[${account}].nonces[${nonce >> 64n}]`,
        `accounts[${account}].keys[${keyId}].expiry`,
        `accounts[${account}].keys[${keyId}].keyType`,
        `accounts[${account}].keys[${keyId}].permissions`,
        `accounts[${account}].keys[${keyId}].publicKey`,
      ];
    },
  },
  CloseOrder: {
    tag: MutationType.CloseOrder,
    params: parseAbiParameters(
      "uint64 orderId, uint256 nonce, uint256 deadline",
    ),
    registerMappingKeys: ({ params, signature }) => {
      const { nonce, orderId } = params as CloseOrderParams;
      const { account } = signature as OrderBookSignature;
      return [
        `accounts[${account}].nonces[${nonce >> 64n}]`,
        `accounts[${account}].orders[${orderId}].quantity`,
      ];
    },
  },
  ChangeOrder: {
    tag: MutationType.ChangeOrder,
    params: parseAbiParameters(
      "uint64 orderId, uint64 price, uint256 nonce, uint256 deadline",
    ),
    registerMappingKeys: ({ params, signature }) => {
      const { nonce, orderId } = params as ChangeOrderParams;
      const { account } = signature as OrderBookSignature;
      return [
        `accounts[${account}].nonces[${nonce >> 64n}]`,
        `accounts[${account}].orders[${orderId}].quantity`,
      ];
    },
  },
  LimitOrder: {
    tag: MutationType.LimitOrder,
    params: parseAbiParameters(
      "uint256 quantity, uint64 instrumentId, uint64 price, uint8 bidOrAsk, uint256 nonce, uint256 deadline",
    ),
    registerMappingKeys: ({ params, signature }) => {
      const { bidOrAsk, instrumentId, nonce, price } =
        params as LimitOrderParams;
      const { account } = signature as OrderBookSignature;
      const side = bidOrAsk === 0 ? "bids" : "asks";
      return [
        `accounts[${account}].nonces[${nonce >> 64n}]`,
        `instruments[${instrumentId}].${side}[${price}].quantity`,
        `instruments[${instrumentId}].${side}[${price}].remainingQuantity`,
        `instruments[${instrumentId}].${side}[${price}].volume`,
      ];
    },
  },
  MarketOrder: {
    tag: MutationType.MarketOrder,
    params: parseAbiParameters(
      "uint256 quantity, uint256 minReceivedQuantity, uint64 instrumentId, uint8 bidOrAsk, uint256 nonce, uint256 deadline",
    ),
    resolution: parseAbiParameters("(uint64 quantity, uint64 price)[] fills"),
    resolve: ({
      state,
      params,
    }: {
      state: unknown;
      params: unknown;
      signature: unknown;
    }) => resolveMarket(state as OrderBookStorage, params as MarketOrderParams),
    registerMappingKeys: ({
      params,
      resolution,
      signature,
    }: {
      params: unknown;
      resolution: unknown;
      signature: unknown;
    }) => {
      const { bidOrAsk, instrumentId, nonce } = params as MarketOrderParams;
      const { fills } = resolution as MarketOrderResolution<bigint>;
      const { account } = signature as OrderBookSignature;
      const side = bidOrAsk === 0 ? "asks" : "bids";
      return [
        `accounts[${account}].nonces[${nonce >> 64n}]`,
        ...fills.flatMap(({ price }) => [
          `instruments[${instrumentId}].${side}[${price}].quantity`,
          `instruments[${instrumentId}].${side}[${price}].remainingQuantity`,
          `instruments[${instrumentId}].${side}[${price}].volume`,
        ]),
      ];
    },
  },
  AddInstrument: {
    tag: MutationType.AddInstrument,
    params: parseAbiParameters(
      "uint64 instrumentId, address base, address quote, uint8 baseLotExp, uint8 quoteLotExp, uint256 nonce, uint256 deadline",
    ),
    registerMappingKeys: ({ params, signature }) => {
      const { instrumentId, nonce } = params as AddInstrumentParams;
      const { account } = signature as OrderBookSignature;
      return [
        `accounts[${account}].nonces[${nonce >> 64n}]`,
        `instruments[${instrumentId}].base`,
        `instruments[${instrumentId}].quote`,
        `instruments[${instrumentId}].baseLotExp`,
        `instruments[${instrumentId}].quoteLotExp`,
      ];
    },
  },
  Deposit: {
    tag: MutationType.Deposit,
    params: parseAbiParameters(
      "address asset, uint256 amount, uint256 nonce, uint256 deadline",
    ),
    registerMappingKeys: ({ params, signature }) => {
      const { asset, nonce } = params as DepositParams;
      const { account } = signature as OrderBookSignature;
      return [
        `accounts[${account}].nonces[${nonce >> 64n}]`,
        `accounts[${account}].balances[${asset}]`,
      ];
    },
  },
  Withdrawal: {
    tag: MutationType.Withdrawal,
    params: parseAbiParameters(
      "address asset, uint256 amount, uint256 nonce, uint256 deadline",
    ),
    registerMappingKeys: ({ params, signature }) => {
      const { asset, nonce } = params as WithdrawalParams;
      const { account } = signature as OrderBookSignature;
      return [
        `accounts[${account}].nonces[${nonce >> 64n}]`,
        `accounts[${account}].balances[${asset}]`,
      ];
    },
  },
} as const satisfies FFCAConfig["mutations"];

export type OrderBookFFCAConfig = Omit<
  FFCAConfig,
  "storageLayout" | "mutations" | "sequencing"
> & {
  storageLayout: typeof EXCHANGE_STORAGE_LAYOUT;
  mutations: typeof ORDER_BOOK_MUTATIONS;
  sequencing: {
    order: "batch";
    batchOrder: typeof ORDER_BOOK_BATCH_ORDER;
    batchIntervalMs?: number;
    submitIntervalMs?: number;
  };
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
