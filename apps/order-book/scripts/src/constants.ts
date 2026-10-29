import type { Address } from "ox/Address";
import superjson from "superjson";

export { GOLD, INSTRUMENTS, USD, WTIOIL } from "order-book-sdk";

export function requiredEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} env var is required`);
  }

  return value;
}

export const API_URL = requiredEnv("API_URL", process.env.API_URL);

// CHAIN_ID and ORDER_BOOK_ADDRESS override the deployment the running backend
// reports, which in development is a new Anvil each time it starts.
const manifest =
  process.env.CHAIN_ID && process.env.ORDER_BOOK_ADDRESS
    ? undefined
    : await backendManifest();

async function backendManifest(): Promise<{
  chainId: number;
  address: Address;
}> {
  const response = await fetch(`${API_URL}/api/manifest`);
  if (!response.ok) {
    throw new Error(
      `Failed to read the deployment from ${API_URL}/api/manifest: HTTP ${response.status}`,
    );
  }
  return superjson.parse(await response.text());
}

export const CHAIN_ID = Number(process.env.CHAIN_ID || manifest?.chainId);
if (Number.isNaN(CHAIN_ID)) {
  throw new Error("CHAIN_ID must be a number");
}

export const ORDER_BOOK_ADDRESS = (process.env.ORDER_BOOK_ADDRESS ||
  manifest?.address) as Address;
