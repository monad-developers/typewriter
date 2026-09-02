import type { Authorization } from "typewriter";

export const ORDER_BOOK_BATCH_ORDER = [
  "CloseOrder",
  "ChangeOrder",
  "LimitOrder",
  "MarketOrder",
  "AddInstrument",
  "Deposit",
  "Withdrawal",
] as const;

export type SubmittedOrderBookMutation<name extends string = string> = {
  name: name;
  params: Record<string, unknown>;
  authorization: Authorization;
};
