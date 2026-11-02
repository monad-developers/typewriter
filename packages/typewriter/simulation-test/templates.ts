import type { AppMutationName, Mutation } from "./assessment";

/** The params of a mutation without `shouldRevert`, which each step draws. */
type Params<name extends AppMutationName> = Omit<
  Mutation<name>["params"],
  "shouldRevert"
>;

/** A well-formed mutation input, before a step gives it an account and a nonce. */
export type Template = {
  [name in AppMutationName]: { name: name; params: Params<name> };
}[AppMutationName];

const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * The inputs a step draws from. Slots repeat, so later writes overwrite
 * earlier ones, and values cover zero, one, and the maximum.
 */
export const TEMPLATES: Template[] = [
  { name: "A", params: { slot: 0n, value: 0n } },
  { name: "A", params: { slot: 1n, value: 1n } },
  { name: "A", params: { slot: 2n, value: MAX_UINT256 } },
  { name: "A", params: { slot: 3n, value: 123_456_789n } },
  { name: "A", params: { slot: MAX_UINT256, value: 7n } },
  { name: "B", params: { slot: 0n, value: 0n } },
  { name: "B", params: { slot: 1n, value: 42n } },
  { name: "B", params: { slot: 2n, value: MAX_UINT256 } },
  { name: "B", params: { slot: 3n, value: 1n << 128n } },
];
