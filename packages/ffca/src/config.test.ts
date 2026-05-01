import { expectTypeOf, test } from "bun:test";
import { createFFCA, createFFCAState } from "./config";

test("createFFCA infers state type", () => {
  const ffca = createFFCA({
    address: "0x0000000000000000000000000000000000000000",
    abi: [],
    // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
    account: {} as any,
    chainId: 1,
    rpcUrl: "http://localhost:8545",
    state: createFFCAState<{ counter: number }>({
      initial: { counter: 0 },
    }),
  });

  expectTypeOf(ffca.state).toEqualTypeOf<{ counter: number }>();
});
