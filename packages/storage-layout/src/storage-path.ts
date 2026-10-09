import type { Hex } from "ox";

/** Human-entered bracket selector. Resolution decides whether this is an array index or mapping key. */
export type StoragePathSubscript =
  | { kind: "number"; value: bigint }
  | { kind: "hex"; value: Hex.Hex }
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean };

type ParsedStoragePath = {
  root: string;
  segments: readonly ParsedStoragePathSegment[];
};

export type ParsedStoragePathSegment =
  | { kind: "field"; name: string }
  | { kind: "subscript" };

export type ParseStoragePath<Path extends string> =
  Path extends `${infer Head}.${infer Tail}`
    ? ParseStoragePathRoot<Head> extends infer Parsed extends ParsedStoragePath
      ? {
          root: Parsed["root"];
          segments: readonly [
            ...Parsed["segments"],
            ...ParseStoragePathTail<Tail>,
          ];
        }
      : never
    : ParseStoragePathRoot<Path>;

const HEX_STRING_PATTERN = /^0x[0-9a-fA-F]*$/;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DECIMAL = /^-?(0|[1-9][0-9]*)$/;

type ParseStoragePathRoot<Segment extends string> =
  Segment extends `${infer Root}[${string}]${infer Rest}`
    ? {
        root: Root;
        segments: readonly [
          { kind: "subscript" },
          ...ParseStoragePathSubscripts<Rest>,
        ];
      }
    : { root: Segment; segments: readonly [] };

type ParseStoragePathTail<Tail extends string> =
  Tail extends `${infer Head}.${infer Rest}`
    ? readonly [...ParseStoragePathSegment<Head>, ...ParseStoragePathTail<Rest>]
    : ParseStoragePathSegment<Tail>;

type ParseStoragePathSegment<Segment extends string> =
  Segment extends `${infer Field}[${string}]${infer Rest}`
    ? Field extends ""
      ? readonly [{ kind: "subscript" }, ...ParseStoragePathSubscripts<Rest>]
      : readonly [
          { kind: "field"; name: Field },
          { kind: "subscript" },
          ...ParseStoragePathSubscripts<Rest>,
        ]
    : readonly [{ kind: "field"; name: Segment }];

type ParseStoragePathSubscripts<Tail extends string> =
  Tail extends `[${string}]${infer Rest}`
    ? readonly [{ kind: "subscript" }, ...ParseStoragePathSubscripts<Rest>]
    : readonly [];

/** Read the identifier at `start`. */
export function readIdentifier(
  input: string,
  start: number,
): { value: string; next: number } {
  let next = start;
  while (next < input.length) {
    const char = input[next]!;
    if (!/[A-Za-z0-9_]/.test(char)) break;
    next++;
  }
  const value = input.slice(start, next);
  if (!IDENTIFIER.test(value)) {
    throw new Error(`expected identifier in storage path: ${input}`);
  }
  return { value, next };
}

/** Read the `[…]` subscript that starts at `start`. */
export function readSubscript(
  input: string,
  start: number,
): { value: StoragePathSubscript; next: number } {
  const end = input.indexOf("]", start + 1);
  if (end === -1) {
    throw new Error(`unterminated subscript in storage path: ${input}`);
  }
  const raw = input.slice(start + 1, end).trim();
  if (raw.length === 0) {
    throw new Error("storage path subscript cannot be empty");
  }
  const value = parseSubscript(raw);
  if (value === undefined) {
    throw new Error(`unsupported storage path subscript: ${raw}`);
  }
  return { value, next: end + 1 };
}

/**
 * Parse the text between `[` and `]` as a subscript: a hex string, a decimal
 * integer, `true` / `false`, or a quoted string. Returns `undefined` for any
 * other text.
 */
export function parseSubscript(raw: string): StoragePathSubscript | undefined {
  if (HEX_STRING_PATTERN.test(raw)) {
    return { kind: "hex", value: raw as Hex.Hex };
  }
  if (DECIMAL.test(raw)) {
    return { kind: "number", value: BigInt(raw) };
  }
  if (raw === "true" || raw === "false") {
    return { kind: "bool", value: raw === "true" };
  }
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return { kind: "string", value: raw.slice(1, -1) };
  }
  return undefined;
}

/**
 * Integer value of an array index or integer mapping key subscript. Hex
 * subscripts are accepted because the type-level `${number}` selector accepts
 * them too.
 */
export function subscriptToInteger(
  subscript: StoragePathSubscript,
): bigint | undefined {
  if (subscript.kind === "number") return subscript.value;
  if (subscript.kind === "hex" && subscript.value !== "0x") {
    return BigInt(subscript.value);
  }
  return undefined;
}

/** Format a subscript as it appears between `[` and `]` in a storage path. */
export function formatSubscript(subscript: StoragePathSubscript): string {
  switch (subscript.kind) {
    case "number":
      return subscript.value.toString();
    case "hex":
      return subscript.value;
    case "string":
      return JSON.stringify(subscript.value);
    case "bool":
      return String(subscript.value);
  }
}
