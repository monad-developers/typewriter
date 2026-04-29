import { useEffect, useState } from "react";
import { getBlockNumber, watchBlockNumber } from "viem/actions";
import { publicClient } from "../lib/client";

export function useBlockNumber() {
  const [blockNumber, setBlockNumber] = useState<bigint | null>(null);

  useEffect(() => {
    getBlockNumber(publicClient).then(setBlockNumber);
    const unwatch = watchBlockNumber(publicClient, {
      onBlockNumber: setBlockNumber,
      pollingInterval: 200,
    });
    return unwatch;
  }, []);

  return blockNumber;
}
