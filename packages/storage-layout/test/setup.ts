// Preloaded by `bunfig.toml` in every test process. The proxy only starts an
// anvil instance on the first request, so unit tests do not pay for one.

import { afterAll, beforeAll } from "bun:test";
import { anvil } from "./anvil";

let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  stop = await anvil.start();
});

afterAll(async () => {
  await stop?.();
});
