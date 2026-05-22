import type { FFCAConfig } from "ffca";
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
import type { EXCHANGE_STORAGE_LAYOUT } from "./storage-layout";

type OrderBookStorage = StorageProxy<typeof EXCHANGE_STORAGE_LAYOUT, true>;
type KnownPriceLevels = Map<number, { bids: Set<number>; asks: Set<number> }>;

export type OrderBookSignature = {
  account: Hex;
  keyId: bigint;
  rawSignature: Hex;
};

type AccountArg = { account: Hex };
type SignedArgs = { nonce: bigint; deadline: bigint };

export type InitializeArgs = Initialize & AccountArg;
export type AuthorizeArgs = Authorize & AccountArg & SignedArgs;
export type RevokeArgs = Revoke & AccountArg & SignedArgs;
export type CloseOrderArgs = CloseOrder & SignedArgs;
export type ChangeOrderArgs = ChangeOrder<bigint> & SignedArgs;
export type LimitOrderArgs = LimitOrder<bigint> & SignedArgs;
export type MarketOrderArgs = MarketOrder<bigint> & SignedArgs;
export type AddInstrumentArgs = AddInstrument & SignedArgs;
export type DepositArgs = Deposit<bigint> & SignedArgs;
export type WithdrawalArgs = Withdrawal<bigint> & SignedArgs;

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

export type SubmittedOrderBookMutation = {
  name: OrderBookMutationName;
  args:
    | InitializeArgs
    | AuthorizeArgs
    | RevokeArgs
    | CloseOrderArgs
    | ChangeOrderArgs
    | LimitOrderArgs
    | MarketOrderArgs
    | AddInstrumentArgs
    | DepositArgs
    | WithdrawalArgs;
  signature: OrderBookSignature;
};

export const ORDER_BOOK_SEQUENCE = [
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

export function createKnownPriceLevels(): KnownPriceLevels {
  return new Map();
}

function rememberLimitPrice(
  knownPriceLevels: KnownPriceLevels,
  args: LimitOrderArgs,
): void {
  const levels = knownPriceLevels.get(args.instrumentId) ?? {
    bids: new Set<number>(),
    asks: new Set<number>(),
  };
  knownPriceLevels.set(args.instrumentId, levels);
  const side = args.bidOrAsk === 0 ? levels.bids : levels.asks;
  side.add(Number(args.price));
}

async function resolveMarket(
  storage: OrderBookStorage,
  args: MarketOrderArgs,
  knownPriceLevels: KnownPriceLevels,
): Promise<MarketOrderResolution<bigint>> {
  const instrument =
    storage.instruments[String(args.instrumentId) as `${number}`];
  const opposingSide = args.bidOrAsk === 0 ? instrument.asks : instrument.bids;
  const priceLevels = knownPriceLevels.get(args.instrumentId);
  const knownPrices = [
    ...((args.bidOrAsk === 0 ? priceLevels?.asks : priceLevels?.bids) ?? []),
  ];
  const prices = (
    knownPrices.length > 0 ? knownPrices : Object.keys(opposingSide).map(Number)
  ).sort((a, b) => (args.bidOrAsk === 0 ? a - b : b - a));
  const baseLotExp = await instrument.baseLotExp;
  const fills: { quantity: bigint; price: bigint }[] = [];
  const quantityLots = args.quantity >> BigInt(baseLotExp);
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
      `InsufficientLiquidity: resolveMarket totalFilled=${quantityLots - remaining} quantityLots=${quantityLots} fillCount=${fills.length} instrumentId=${args.instrumentId}`,
    );
  }

  return { fills };
}

export function baseMutations(
  knownPriceLevels: KnownPriceLevels = createKnownPriceLevels(),
): FFCAConfig["mutations"] {
  return {
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
      registerMappingKeys: ({ args, signature }) => {
        const { nonce } = args as AuthorizeArgs;
        const { account } = signature as OrderBookSignature;
        return [`accounts[${account}].nonces[${nonce >> 64n}]`];
      },
    },
    Revoke: {
      tag: MutationType.Revoke,
      params: parseAbiParameters(
        "bytes32 account, uint64 keyId, uint256 nonce, uint256 deadline",
      ),
      registerMappingKeys: ({ args, signature }) => {
        const { keyId, nonce } = args as RevokeArgs;
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
      registerMappingKeys: ({ args, signature }) => {
        const { nonce, orderId } = args as CloseOrderArgs;
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
      registerMappingKeys: ({ args, signature }) => {
        const { nonce, orderId } = args as ChangeOrderArgs;
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
      registerMappingKeys: ({ args, signature }) => {
        const limitOrder = args as LimitOrderArgs;
        rememberLimitPrice(knownPriceLevels, limitOrder);
        const { bidOrAsk, instrumentId, nonce, price } = limitOrder;
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
        args,
      }: {
        state: unknown;
        args: unknown;
        signature: unknown;
      }) =>
        resolveMarket(
          state as OrderBookStorage,
          args as MarketOrderArgs,
          knownPriceLevels,
        ),
      registerMappingKeys: ({ args, resolution, signature }) => {
        const { bidOrAsk, instrumentId, nonce } = args as MarketOrderArgs;
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
      registerMappingKeys: ({ args, signature }) => {
        const { instrumentId, nonce } = args as AddInstrumentArgs;
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
      registerMappingKeys: ({ args, signature }) => {
        const { asset, nonce } = args as DepositArgs;
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
      registerMappingKeys: ({ args, signature }) => {
        const { asset, nonce } = args as WithdrawalArgs;
        const { account } = signature as OrderBookSignature;
        return [
          `accounts[${account}].nonces[${nonce >> 64n}]`,
          `accounts[${account}].balances[${asset}]`,
        ];
      },
    },
  };
}

export function normalizeSignatureForContract(
  signature: OrderBookSignature,
): OrderBookSignature {
  if (signature.rawSignature.length !== 132) return signature;

  const { v, r, s } = parseSignature(signature.rawSignature);
  return {
    ...signature,
    rawSignature: encodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
      [Number(v), r, s],
    ),
  };
}
