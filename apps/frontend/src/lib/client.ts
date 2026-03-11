import { createPublicClient, http } from "viem";
import { anvil } from "viem/chains";
import { RPC_URL } from "../constants";

export const publicClient = createPublicClient({
  transport: http(RPC_URL),
  chain: anvil,
});
