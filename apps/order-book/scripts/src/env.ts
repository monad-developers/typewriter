import { INSTRUMENTS, type InstrumentConfig, type Side } from "order-book-sdk";

export type InstrumentName = keyof typeof INSTRUMENTS;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function requiredEnv(name: string, example?: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    fail(`${name} env var is required${example ? ` (e.g. ${example})` : ""}`);
  }
  return value;
}

export function sideEnv(): Side {
  const side = requiredEnv("SIDE", "buy or sell");
  if (side !== "buy" && side !== "sell") {
    fail("SIDE env var must be 'buy' or 'sell'");
  }
  return side;
}

function instrumentNamed(name: string): {
  name: InstrumentName;
  instrument: InstrumentConfig;
} {
  if (!(name in INSTRUMENTS)) fail(`unknown instrument: ${name}`);
  return {
    name: name as InstrumentName,
    instrument: INSTRUMENTS[name as InstrumentName],
  };
}

export function instrumentEnv() {
  return instrumentNamed(requiredEnv("INSTRUMENT", "GOLD/USD"));
}

/** `INSTRUMENT`, or every instrument when it is unset. */
export function instrumentsEnv() {
  const name = process.env.INSTRUMENT;
  return name
    ? [instrumentNamed(name)]
    : Object.keys(INSTRUMENTS).map(instrumentNamed);
}

export function intervalEnv(): number {
  return Number(process.env.INTERVAL ?? 10_000);
}
