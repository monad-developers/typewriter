import { createPublicClient } from "viem";
import { anvil } from "viem/chains";
import { RPC_URL } from "../constants";
import { loggingTransport } from "./loggingTransport";

export const publicClient = createPublicClient({
  transport: loggingTransport(RPC_URL),
  chain: anvil,
});
