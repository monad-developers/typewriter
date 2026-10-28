import { Hex } from "ox";
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
const MAX_INT64 = (1n << 63n) - 1n;
const MAX_UINT40 = 2 ** 40 - 1;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_ADDRESS = "0xffffffffffffffffffffffffffffffffffffffff";
/** Mixed case, as a checksummed address is written. */
const CHECKSUMMED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const ZERO_BYTES32 = Hex.padLeft("0x", 32);
const MAX_BYTES32 = Hex.padLeft(Hex.fromNumber(MAX_UINT256), 32);

/** `size` bytes counting up from `0x00`, so neighbouring sizes differ. */
function bytes(size: number): Hex.Hex {
  return Hex.fromBytes(Uint8Array.from({ length: size }, (_, i) => i % 256));
}

/**
 * The inputs a step draws from. Each covers edge values of its types: zero,
 * maximum, empty, a word boundary, and text a database stores with care.
 */
export const TEMPLATES: Template[] = [
  { name: "A", params: { slot: 0n, value: 0n } },
  { name: "A", params: { slot: 1n, value: 1n } },
  { name: "A", params: { slot: 2n, value: MAX_UINT256 } },
  { name: "A", params: { slot: 3n, value: 123_456_789n } },
  { name: "A", params: { slot: MAX_UINT256, value: 7n } },
  { name: "B", params: { slot: 0n, value: 0n } },
  { name: "B", params: { slot: 4n, value: 42n } },
  { name: "B", params: { slot: 5n, value: MAX_UINT256 } },
  { name: "B", params: { slot: 6n, value: 1n << 128n } },

  { name: "C", params: { slot: 7n, data: "0x", memo: "" } },
  { name: "C", params: { slot: 8n, data: "0x00", memo: "memo" } },
  { name: "C", params: { slot: 9n, data: bytes(31), memo: "a".repeat(31) } },
  { name: "C", params: { slot: 10n, data: bytes(32), memo: "b".repeat(32) } },
  { name: "C", params: { slot: 11n, data: bytes(33), memo: "c".repeat(33) } },
  { name: "C", params: { slot: 12n, data: bytes(1_000), memo: "long" } },
  { name: "C", params: { slot: 7n, data: "0xff", memo: "héllo wörld 🌍" } },
  { name: "C", params: { slot: 8n, data: "0xff", memo: `quotes ' " \\ ;` } },
  { name: "C", params: { slot: 9n, data: "0xff", memo: "nul \u0000 byte" } },

  {
    name: "D",
    params: {
      slot: 13n,
      to: ZERO_ADDRESS,
      delta: 0n,
      tag: ZERO_BYTES32,
      small: 0,
      window: 0,
    },
  },
  {
    name: "D",
    params: {
      slot: 14n,
      to: MAX_ADDRESS,
      delta: MAX_INT64,
      tag: MAX_BYTES32,
      small: 255,
      window: MAX_UINT40,
    },
  },
  {
    name: "D",
    params: {
      slot: 15n,
      to: CHECKSUMMED_ADDRESS,
      delta: -MAX_INT64 - 1n,
      tag: bytes(32),
      small: 1,
      window: 1,
    },
  },
  {
    name: "D",
    params: {
      slot: 13n,
      to: CHECKSUMMED_ADDRESS,
      delta: -1n,
      tag: ZERO_BYTES32,
      small: 128,
      window: 2 ** 32,
    },
  },

  {
    name: "E",
    params: { slot: 14n, values: [], pair: [ZERO_ADDRESS, ZERO_ADDRESS] },
  },
  {
    name: "E",
    params: { slot: 15n, values: [0n], pair: [MAX_ADDRESS, ZERO_ADDRESS] },
  },
  {
    name: "E",
    params: {
      slot: 0n,
      values: [MAX_UINT256, 1n],
      pair: [CHECKSUMMED_ADDRESS, MAX_ADDRESS],
    },
  },
  {
    name: "E",
    params: {
      slot: 1n,
      values: Array.from({ length: 40 }, (_, i) => BigInt(i)),
      pair: [CHECKSUMMED_ADDRESS, CHECKSUMMED_ADDRESS],
    },
  },
];
