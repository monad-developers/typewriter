import type { Hex } from "ox";

/**
 * Structured representation of a Solidity storage variable or sub-value.
 *
 * @example
 * // totalSupply
 * { root: "totalSupply", segments: [] }
 *
 * @example
 * // accounts[0xabcd].orders[3].price
 * {
 *   root: "accounts",
 *   segments: [
 *     { kind: "subscript", value: { kind: "hex", value: "0xabcd" } },
 *     { kind: "field", name: "orders" },
 *     { kind: "subscript", value: { kind: "number", value: 3n } },
 *     { kind: "field", name: "price" },
 *   ],
 * }
 */
export type StoragePath = {
  root: string;
  segments: readonly StoragePathSegment[];
};

/** One step after the root variable in a `StoragePath`. */
type StoragePathSegment =
  | { kind: "field"; name: string }
  | { kind: "subscript"; value: StoragePathSubscript };

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

/**
 * Parse a human-readable Solidity storage path into structured form.
 *
 * @example
 * parseStoragePath("metadata.lastUpdate")
 * parseStoragePath("balances[0x1234]")
 */
export function parseStoragePath(input: string): StoragePath {
  if (input.length === 0) {
    throw new Error("storage path cannot be empty");
  }

  let index = 0;
  const root = readIdentifier(input, index);
  index = root.next;
  const segments: StoragePathSegment[] = [];

  while (index < input.length) {
    const char = input[index];
    if (char === ".") {
      const field = readIdentifier(input, index + 1);
      segments.push({ kind: "field", name: field.value });
      index = field.next;
      continue;
    }
    if (char === "[") {
      const end = input.indexOf("]", index + 1);
      if (end === -1) {
        throw new Error(`unterminated subscript in storage path: ${input}`);
      }
      const raw = input.slice(index + 1, end).trim();
      if (raw.length === 0) {
        throw new Error("storage path subscript cannot be empty");
      }
      const subscript = parseSubscript(raw);
      if (subscript === undefined) {
        throw new Error(`unsupported storage path subscript: ${raw}`);
      }
      segments.push({ kind: "subscript", value: subscript });
      index = end + 1;
      continue;
    }
    throw new Error(`unexpected '${char}' in storage path: ${input}`);
  }

  return { root: root.value, segments };
}

export function formatStoragePath(path: StoragePath): string {
  let out = path.root;
  for (const segment of path.segments) {
    if (segment.kind === "field") {
      out += `.${segment.name}`;
    } else {
      out += `[${formatSubscript(segment.value)}]`;
    }
  }
  return out;
}

function readIdentifier(
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
