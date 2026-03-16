import type { Address } from "viem";
import { publicClient } from "./client";

class NonceManager {
  private nonces = new Map<Address, number>();

  async getNonce(address: Address): Promise<number> {
    if (!this.nonces.has(address)) {
      const nonce = await publicClient.getTransactionCount({
        address,
        blockTag: "pending",
      });
      this.nonces.set(address, nonce);
    }
    const nonce = this.nonces.get(address)!;
    this.nonces.set(address, nonce + 1);
    return nonce;
  }

  reset(address: Address) {
    this.nonces.delete(address);
  }
}

export const nonceManager = new NonceManager();
