import { test } from "bun:test";
import { parseAbiParameters } from "abitype";
import { createFFCA } from "./runtime";

const baseConfig = {
  address: "0x0000000000000000000000000000000000000000",
  abi: [],
  // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
  account: {} as any,
  chainId: 1,
  rpcUrl: "http://localhost:8545",
  domain: { name: "", version: "1" },
} as const;

test("createFFCA state", async () => {
  const ffca = createFFCA({
    ...baseConfig,
    state: { initial: { counter: 0 } },
    mutations: {},
  });
  await ffca.stop();
});

test("createFFCA mutation", async () => {
  const ffca = createFFCA({
    ...baseConfig,
    state: { initial: new Map<string, { balance: bigint }>() },
    mutations: {
      transfer: {
        tag: 0,
        params: parseAbiParameters("address from, address to, uint256 amount"),
        apply: (state: unknown, args: unknown) => {
          const { from, to, amount } = args as {
            from: string;
            to: string;
            amount: bigint;
          };
          const accounts = state as Map<string, { balance: bigint }>;
          const sender = accounts.get(from);
          if (!sender || sender.balance < amount) {
            throw new Error("insufficient balance");
          }
          sender.balance -= amount;
          const recipient = accounts.get(to) ?? { balance: 0n };
          recipient.balance += amount;
          accounts.set(to, recipient);
        },
      },
    },
  });
  await ffca.stop();
});

test("createFFCA mutation with resolution", async () => {
  const ffca = createFFCA({
    ...baseConfig,
    state: { initial: { bids: [] as { price: bigint; size: bigint }[] } },
    mutations: {
      marketOrder: {
        tag: 1,
        params: parseAbiParameters("uint256 size"),
        resolution: parseAbiParameters("(uint256 price, uint256 size)[] fills"),
        resolve: (state, args) => {
          const { bids } = state as { bids: { price: bigint; size: bigint }[] };
          const { size } = args as { size: bigint };
          const fills: { price: bigint; size: bigint }[] = [];
          let remaining = size;
          for (const bid of bids) {
            if (remaining === 0n) break;
            const fillSize = bid.size < remaining ? bid.size : remaining;
            fills.push({ price: bid.price, size: fillSize });
            remaining -= fillSize;
          }
          return { fills };
        },
        apply: (state, _args, resolution) => {
          const s = state as { bids: { price: bigint; size: bigint }[] };
          const { fills } = resolution as {
            fills: { price: bigint; size: bigint }[];
          };
          let remaining = fills.reduce((sum, f) => sum + f.size, 0n);
          while (remaining > 0n && s.bids.length > 0) {
            const bid = s.bids[0];
            if (!bid) break;
            if (bid.size <= remaining) {
              remaining -= bid.size;
              s.bids.shift();
            } else {
              bid.size -= remaining;
              remaining = 0n;
            }
          }
        },
      },
    },
  });
  await ffca.stop();
});
