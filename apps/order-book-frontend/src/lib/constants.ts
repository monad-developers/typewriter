import { USD, GOLD, WTIOIL, INSTRUMENTS, type InstrumentConfig } from "order-book-sdk";

export { USD, GOLD, WTIOIL };
export type { InstrumentConfig } from "order-book-sdk";
export { TokenAmount, INSTRUMENTS } from "order-book-sdk";

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

const INSTRUMENT_BY_ID = new Map<number, InstrumentConfig>(
  Object.values(INSTRUMENTS).map((i) => [i.id, i]),
);

export function instrumentConfig(id: number): InstrumentConfig {
  const inst = INSTRUMENT_BY_ID.get(id);
  if (!inst) throw new Error(`Unknown instrument ${id}`);
  return inst;
}

const TOKEN_NAMES: Record<string, string> = {
  [USD]: "USD",
  [GOLD]: "GOLD",
  [WTIOIL]: "WTIOIL",
};

export function tokenName(address: string): string {
  return TOKEN_NAMES[address.toLowerCase()] ?? address.slice(0, 6);
}
