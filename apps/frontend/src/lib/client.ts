import { createPublicClient } from "viem";
import { CHAIN, RPC_URL } from "../constants";
import { loggingTransport } from "./loggingTransport";

export const publicClient = createPublicClient({
  transport: loggingTransport(RPC_URL, { silent: ["eth_blockNumber"] }),
  chain: CHAIN,
});
