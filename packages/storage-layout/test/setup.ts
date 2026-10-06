// Anvil starts on the first request, so unit tests do not start it.

import { afterAll, beforeAll } from "bun:test";
import { anvil } from "./anvil";

let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  stop = await anvil.start();
});

afterAll(async () => {
  await stop?.();
});
