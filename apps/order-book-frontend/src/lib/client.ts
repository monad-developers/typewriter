import { createPublicClient, http } from "viem";
import { CHAIN, RPC_URL } from "../constants";

export const publicClient = createPublicClient({
  transport: http(RPC_URL, { retryCount: 0 }),
  chain: CHAIN,
});
