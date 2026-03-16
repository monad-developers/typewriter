import type { Address } from "viem";
import { publicClient } from "./client";

class NonceManager {
  private nonces = new Map<Address, number>();

  async prefetch(address: Address): Promise<void> {
    const nonce = await publicClient.getTransactionCount({
      address,
      blockTag: "pending",
    });
    this.nonces.set(address, nonce);
  }

  async consume(address: Address): Promise<number> {
    if (!this.nonces.has(address)) {
      await this.prefetch(address);
    }
    const nonce = this.nonces.get(address) ?? 0;
    this.nonces.set(address, nonce + 1);
    return nonce;
  }

  reset(address: Address) {
    this.nonces.delete(address);
  }
}

export const nonceManager = new NonceManager();
