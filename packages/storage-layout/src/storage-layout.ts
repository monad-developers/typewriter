import type { AbiParameterToPrimitiveType, AbiType } from "abitype";
import { Hash, Hex } from "ox";
import {
  formatStoragePath,
  type NormalizeStoragePath,
  type ParsedStoragePath,
  type ParsedStoragePathSegment,
  type StoragePath,
  type StoragePathSegment,
} from "./storage-path";

/**
 * Storage item as defined in the JSON output of the Solidity compiler.
 *
 * @see https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html#json-output
 */
export type StorageItem = {
  /** ID of the AST node of the state variable's declaration. */
  astId: number;
  /** Name of the contract including its path as prefix. */
  contract: `${string}:${string}`;
  /** Name of the state variable. */
  label: string;
  /** Offset in bytes within the storage slot according to the encoding. */
  offset: number;
  /** Storage slot where the state variable resides or starts. */
  slot: `${number}`;
  /** Identifier used as key to the variable's type information. */
  type: string;
};

/**
 * Storage type as defined in the JSON output of the Solidity compiler.
 *
 * @see https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html#json-output
 */
export type StorageType = {
  /** How the data is encoded in storage. */
  encoding: "inplace" | "dynamic_array" | "bytes" | "mapping";
  /** Canonical type name. */
  label: string;
  /** Number of used bytes. If greater than 32, the value spans multiple slots. */
  numberOfBytes: `${number}`;
  /** Members for struct types. */
  members?: readonly StorageItem[];
  /** Base type for array types. */
  base?: string;
  /** Key type for mapping types. */
  key?: string;
  /** Value type for mapping types. */
  value?: string;
};

/**
 * Storage layout as defined in the JSON output of the Solidity compiler.
 *
 * @see https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html#json-output
 */
export type StorageLayout = {
  storage: readonly StorageItem[];
  types: Record<string, StorageType>;
};

/** Storage layout item resolved to an absolute path context. */
export type ResolvedStorageItem = {
  path: StoragePath;
  item: StorageItem;
  type: StorageType;
  baseSlot: bigint;
};

type Pretty<T> = { [K in keyof T]: T[K] } & unknown;

type CustomTypeError<Message extends string> = [`Error: ${Message}`];

export type ExtractVariableNames<Layout extends StorageLayout> =
  Layout["storage"][number]["label"];

export type ExtractStoragePaths<Layout extends StorageLayout> =
  StorageItemPaths<Layout, Layout["storage"][number]>;

export type StorageLayoutToPrimitiveType<Layout extends StorageLayout> =
  Pretty<{
    [Name in ExtractVariableNames<Layout>]: StoragePathToPrimitiveType<
      Layout,
      Name
    >;
  }>;

export type StoragePathToPrimitiveType<
  Layout extends StorageLayout,
  Path extends string | StoragePath,
> = StoragePathTypeToPrimitiveType<Layout, StorageTypeForPath<Layout, Path>>;

export type IsSingleSlot<
  Layout extends StorageLayout,
  Path extends string | StoragePath,
> = IsStoragePathTypeSingleSlot<StorageTypeForPath<Layout, Path>>;

export function resolveStoragePath(
  layout: StorageLayout,
  path: StoragePath,
): ResolvedStorageItem[] {
  let item = findStorageItem(layout, path.root);
  let baseSlot = 0n;
  let resolvedPath: StoragePath = { root: path.root, segments: [] };
  let type = findStorageType(layout, item.type);

  for (const segment of path.segments) {
    const absoluteSlot = baseSlot + BigInt(item.slot);
    if (segment.kind === "subscript") {
      if (isFixedArrayType(type)) {
        const resolved = resolveFixedArrayElement(
          layout,
          item,
          type,
          absoluteSlot,
          segment,
          resolvedPath,
        );
        item = resolved.item;
        baseSlot = resolved.baseSlot;
        resolvedPath = resolved.path;
        type = resolved.type;
        continue;
      }
      if (isDynamicArrayType(type)) {
        const resolved = resolveDynamicArrayElement(
          layout,
          item,
          type,
          absoluteSlot,
          segment,
          resolvedPath,
        );
        item = resolved.item;
        baseSlot = resolved.baseSlot;
        resolvedPath = resolved.path;
        type = resolved.type;
        continue;
      }
      if (isMappingType(type)) {
        const resolved = resolveMappingValue(
          layout,
          item,
          type,
          absoluteSlot,
          segment,
          resolvedPath,
        );
        item = resolved.item;
        baseSlot = resolved.baseSlot;
        resolvedPath = resolved.path;
        type = resolved.type;
        continue;
      }
      if (isFixedArrayType(type) === false) {
        throw new Error(
          `subscript storage paths are not supported yet: ${formatStoragePath({
            root: path.root,
            segments: [...resolvedPath.segments, segment],
          })}`,
        );
      }
    }
    if (segment.kind !== "field") {
      throw new Error(
        `subscript storage paths are not supported yet: ${formatStoragePath({
          root: path.root,
          segments: [...resolvedPath.segments, segment],
        })}`,
      );
    }
    if (isStructType(type) === false) {
      throw new Error(
        `storage path field '${segment.name}' requires a struct: ${formatStoragePath(resolvedPath)}`,
      );
    }

    const member = type.members.find(
      (candidate) => candidate.label === segment.name,
    );
    if (member === undefined) {
      throw new Error(
        `struct field not found: ${formatStoragePath(resolvedPath)}.${segment.name}`,
      );
    }

    item = member;
    baseSlot = absoluteSlot;
    resolvedPath = {
      root: path.root,
      segments: [...resolvedPath.segments, segment],
    };
    type = findStorageType(layout, item.type);
  }

  const absoluteSlot = baseSlot + BigInt(item.slot);

  if (isValueType(type)) {
    return [
      {
        path: resolvedPath,
        item,
        type,
        baseSlot,
      },
    ];
  }
  if (isStructType(type)) {
    return expandStructSlots(layout, type, absoluteSlot, resolvedPath, true);
  }
  if (isFixedArrayType(type)) {
    return expandFixedArraySlots(
      layout,
      item,
      type,
      absoluteSlot,
      resolvedPath,
    );
  }
  if (isDynamicArrayType(type)) {
    return [
      {
        path: resolvedPath,
        item,
        type,
        baseSlot,
      },
    ];
  }
  if (isBytesType(type)) {
    return [
      {
        path: resolvedPath,
        item,
        type,
        baseSlot,
      },
    ];
  }
  if (isMappingType(type)) {
    throw new Error(
      `mapping storage paths require a key: ${formatStoragePath(resolvedPath)}`,
    );
  }

  throw new Error(
    `unsupported storage path type '${type.label}' for ${formatStoragePath(resolvedPath)}`,
  );
}

export function storagePathEndsAtValue(
  layout: StorageLayout,
  path: StoragePath,
): boolean {
  const resolved = resolveStoragePath(layout, path);
  return (
    resolved.length === 1 &&
    resolved[0]!.type.encoding !== "dynamic_array" &&
    formatStoragePath(resolved[0]!.path) === formatStoragePath(path)
  );
}

function expandStructSlots(
  layout: StorageLayout,
  type: StorageType & { members: readonly StorageItem[] },
  baseSlot: bigint,
  path: StoragePath,
  strict: boolean,
): ResolvedStorageItem[] {
  const slots: ResolvedStorageItem[] = [];
  for (const member of type.members) {
    const memberType = findStorageType(layout, member.type);
    const memberPath: StoragePath = {
      root: path.root,
      segments: [...path.segments, { kind: "field", name: member.label }],
    };
    const memberSlot = baseSlot + BigInt(member.slot);
    if (isValueType(memberType)) {
      slots.push({
        path: memberPath,
        item: member,
        type: memberType,
        baseSlot,
      });
      continue;
    }
    if (isStructType(memberType)) {
      slots.push(
        ...expandStructSlots(
          layout,
          memberType,
          memberSlot,
          memberPath,
          strict,
        ),
      );
      continue;
    }
    if (isFixedArrayType(memberType)) {
      slots.push(
        ...expandFixedArraySlots(
          layout,
          member,
          memberType,
          memberSlot,
          memberPath,
        ),
      );
      continue;
    }
    if (isDynamicArrayType(memberType)) {
      slots.push({
        path: memberPath,
        item: member,
        type: memberType,
        baseSlot,
      });
      continue;
    }
    if (isBytesType(memberType)) {
      slots.push({
        path: memberPath,
        item: member,
        type: memberType,
        baseSlot,
      });
      continue;
    }
    if (strict) {
      if (memberType.encoding === "mapping") {
        throw new Error(
          `cannot infer storage path for mapping '${formatStoragePath(memberPath)}' from raw slots: Solidity mapping keys are hashed into storage slots and cannot be reversed from a slot alone`,
        );
      }
      throw new Error(
        `unsupported storage path type '${memberType.label}' for ${formatStoragePath(memberPath)}`,
      );
    }
  }
  return slots;
}

function expandFixedArraySlots(
  layout: StorageLayout,
  item: StorageItem,
  type: StorageType & { base: string },
  baseSlot: bigint,
  path: StoragePath,
): ResolvedStorageItem[] {
  const slots: ResolvedStorageItem[] = [];
  const length = fixedArrayLength(type);
  for (let index = 0; index < length; index++) {
    const resolved = resolveFixedArrayElement(
      layout,
      item,
      type,
      baseSlot,
      { kind: "subscript", value: { kind: "number", value: BigInt(index) } },
      path,
    );
    if (isValueType(resolved.type)) {
      slots.push(resolved);
      continue;
    }
    const elementSlot = resolved.baseSlot + BigInt(resolved.item.slot);
    if (isStructType(resolved.type)) {
      slots.push(
        ...expandStructSlots(
          layout,
          resolved.type,
          elementSlot,
          resolved.path,
          true,
        ),
      );
      continue;
    }
    if (isFixedArrayType(resolved.type)) {
      slots.push(
        ...expandFixedArraySlots(
          layout,
          resolved.item,
          resolved.type,
          elementSlot,
          resolved.path,
        ),
      );
      continue;
    }
    if (isDynamicArrayType(resolved.type)) {
      slots.push(resolved);
      continue;
    }
    if (isBytesType(resolved.type)) {
      slots.push(resolved);
      continue;
    }
    if (resolved.type.encoding === "mapping") {
      throw new Error(
        `mapping storage paths require a key: ${formatStoragePath(resolved.path)}`,
      );
    }
    throw new Error(
      `unsupported storage path type '${resolved.type.label}' for ${formatStoragePath(resolved.path)}`,
    );
  }
  return slots;
}

function resolveFixedArrayElement(
  layout: StorageLayout,
  item: StorageItem,
  type: StorageType & { base: string },
  baseSlot: bigint,
  segment: Extract<StoragePathSegment, { kind: "subscript" }>,
  path: StoragePath,
): ResolvedStorageItem {
  const index = fixedArrayIndex(segment, type, path);
  const baseType = findStorageType(layout, type.base);
  const { slot, offset } = fixedArrayElementLocation(baseType, index);
  return {
    path: { root: path.root, segments: [...path.segments, segment] },
    item: {
      astId: item.astId,
      contract: item.contract,
      label: `${item.label}[${index}]`,
      offset,
      slot: String(slot) as `${number}`,
      type: type.base,
    },
    type: baseType,
    baseSlot,
  };
}

function resolveDynamicArrayElement(
  layout: StorageLayout,
  item: StorageItem,
  type: StorageType & { base: string },
  absoluteSlot: bigint,
  segment: Extract<StoragePathSegment, { kind: "subscript" }>,
  path: StoragePath,
): ResolvedStorageItem {
  const index = dynamicArrayIndex(segment, path);
  const baseType = findStorageType(layout, type.base);
  const { slot, offset } = arrayElementLocation(baseType, index);
  return {
    path: { root: path.root, segments: [...path.segments, segment] },
    item: {
      astId: item.astId,
      contract: item.contract,
      label: `${item.label}[${index}]`,
      offset,
      slot: String(slot) as `${number}`,
      type: type.base,
    },
    type: baseType,
    baseSlot: dynamicArrayDataBaseSlot(absoluteSlot),
  };
}

function resolveMappingValue(
  layout: StorageLayout,
  item: StorageItem,
  type: StorageType & { key: string; value: string },
  absoluteSlot: bigint,
  segment: Extract<StoragePathSegment, { kind: "subscript" }>,
  path: StoragePath,
): ResolvedStorageItem {
  const valueType = findStorageType(layout, type.value);
  const keyType = findStorageType(layout, type.key);
  return {
    path: { root: path.root, segments: [...path.segments, segment] },
    item: {
      astId: item.astId,
      contract: item.contract,
      label: `${item.label}[${formatSubscript(segment)}]`,
      offset: 0,
      slot: "0",
      type: type.value,
    },
    type: valueType,
    baseSlot: mappingValueBaseSlot(keyType, segment, absoluteSlot, path),
  };
}

function fixedArrayElementLocation(
  type: StorageType,
  index: number,
): { slot: number; offset: number } {
  const location = arrayElementLocation(type, BigInt(index));
  return { slot: Number(location.slot), offset: location.offset };
}

function arrayElementLocation(
  type: StorageType,
  index: bigint,
): { slot: bigint; offset: number } {
  const numberOfBytes = Number(type.numberOfBytes);
  if (isValueType(type)) {
    const valuesPerSlot = Math.floor(32 / numberOfBytes);
    const valuesPerSlotBigInt = BigInt(valuesPerSlot);
    return {
      slot: index / valuesPerSlotBigInt,
      offset: Number(index % valuesPerSlotBigInt) * numberOfBytes,
    };
  }
  return {
    slot: index * BigInt(Math.ceil(numberOfBytes / 32)),
    offset: 0,
  };
}

function dynamicArrayDataBaseSlot(slot: bigint): bigint {
  return BigInt(Hash.keccak256(Hex.fromNumber(slot, { size: 32 })));
}

function mappingValueBaseSlot(
  keyType: StorageType,
  segment: Extract<StoragePathSegment, { kind: "subscript" }>,
  slot: bigint,
  path: StoragePath,
): bigint {
  return BigInt(
    Hash.keccak256(
      Hex.concat(
        encodeMappingKey(keyType, segment, path),
        Hex.fromNumber(slot, { size: 32 }),
      ),
    ),
  );
}

function encodeMappingKey(
  keyType: StorageType,
  segment: Extract<StoragePathSegment, { kind: "subscript" }>,
  path: StoragePath,
): Hex.Hex {
  const label = keyType.label;
  if (label === "address") {
    if (segment.value.kind !== "hex") {
      throw new Error(
        `mapping key for '${formatStoragePath(path)}' must be an address hex string`,
      );
    }
    if (Hex.size(segment.value.value) !== 20) {
      throw new Error(
        `mapping key for '${formatStoragePath(path)}' must be 20 bytes`,
      );
    }
    return Hex.padLeft(segment.value.value, 32);
  }
  if (label === "bool") {
    if (segment.value.kind !== "bool") {
      throw new Error(
        `mapping key for '${formatStoragePath(path)}' must be a boolean`,
      );
    }
    return Hex.fromNumber(segment.value.value ? 1 : 0, { size: 32 });
  }
  if (label.startsWith("uint")) {
    return encodeMappingIntegerKey(label, "uint", segment, path);
  }
  if (label.startsWith("int")) {
    return encodeMappingIntegerKey(label, "int", segment, path);
  }
  if (/^bytes([1-9]|[12][0-9]|3[0-2])$/.test(label)) {
    if (segment.value.kind !== "hex") {
      throw new Error(
        `mapping key for '${formatStoragePath(path)}' must be a fixed bytes hex string`,
      );
    }
    const size = Number(label.slice("bytes".length));
    if (Hex.size(segment.value.value) !== size) {
      throw new Error(
        `mapping key for '${formatStoragePath(path)}' must be ${size} bytes`,
      );
    }
    return Hex.padRight(segment.value.value, 32);
  }

  // TODO: Solidity supports dynamic bytes/string mapping keys, but their slot
  // derivation hashes the raw key bytes rather than ABI-padding a fixed-width key.
  // Leave them unsupported until we add explicit tests for those storage rules.
  throw new Error(`unsupported mapping key type: ${label}`);
}

function encodeMappingIntegerKey(
  label: string,
  kind: "uint" | "int",
  segment: Extract<StoragePathSegment, { kind: "subscript" }>,
  path: StoragePath,
): Hex.Hex {
  if (segment.value.kind !== "number") {
    throw new Error(
      `mapping key for '${formatStoragePath(path)}' must be an integer`,
    );
  }
  const bits = integerBits(label, kind);
  const value = segment.value.value;
  if (kind === "uint") {
    const max = 1n << BigInt(bits);
    if (value < 0n || value >= max) {
      throw new Error(`mapping key does not fit in ${bits} bits`);
    }
    return Hex.fromNumber(value, { size: 32 });
  }

  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  if (value < min || value > max) {
    throw new Error(`mapping key does not fit in ${bits} bits`);
  }
  return Hex.fromNumber(value >= 0n ? value : (1n << 256n) + value, {
    size: 32,
  });
}

function integerBits(label: string, prefix: "uint" | "int"): number {
  const suffix = label.slice(prefix.length);
  const bits = suffix === "" ? 256 : Number(suffix);
  if (!Number.isInteger(bits) || bits < 8 || bits > 256 || bits % 8 !== 0) {
    throw new Error(`invalid Solidity integer type: ${label}`);
  }
  return bits;
}

function formatSubscript(
  segment: Extract<StoragePathSegment, { kind: "subscript" }>,
): string {
  switch (segment.value.kind) {
    case "number":
      return segment.value.value.toString();
    case "hex":
      return segment.value.value;
    case "string":
      return JSON.stringify(segment.value.value);
    case "bool":
      return String(segment.value.value);
  }
}

function fixedArrayIndex(
  segment: Extract<StoragePathSegment, { kind: "subscript" }>,
  type: StorageType,
  path: StoragePath,
): number {
  if (segment.value.kind !== "number") {
    throw new Error(
      `fixed array index must be a number: ${formatStoragePath({
        root: path.root,
        segments: [...path.segments, segment],
      })}`,
    );
  }
  const length = fixedArrayLength(type);
  const index = Number(segment.value.value);
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    throw new Error(
      `fixed array index out of bounds: ${formatStoragePath({
        root: path.root,
        segments: [...path.segments, segment],
      })}`,
    );
  }
  return index;
}

function dynamicArrayIndex(
  segment: Extract<StoragePathSegment, { kind: "subscript" }>,
  path: StoragePath,
): bigint {
  if (segment.value.kind !== "number") {
    throw new Error(
      `dynamic array index must be a number: ${formatStoragePath({
        root: path.root,
        segments: [...path.segments, segment],
      })}`,
    );
  }
  if (segment.value.value < 0n) {
    throw new Error(
      `dynamic array index out of bounds: ${formatStoragePath({
        root: path.root,
        segments: [...path.segments, segment],
      })}`,
    );
  }
  return segment.value.value;
}

function fixedArrayLength(type: StorageType): number {
  const match = /\[([0-9]+)\]$/.exec(type.label);
  if (match === null) {
    throw new Error(`fixed array type '${type.label}' is missing length`);
  }
  return Number(match[1]);
}

function findStorageItem(layout: StorageLayout, label: string): StorageItem {
  const item = layout.storage.find((candidate) => candidate.label === label);
  if (item === undefined) {
    throw new Error(`storage variable not found: ${label}`);
  }
  return item;
}

function findStorageType(layout: StorageLayout, typeId: string): StorageType {
  const type = layout.types[typeId];
  if (type === undefined) {
    throw new Error(`storage type not found: ${typeId}`);
  }
  return type;
}

function isValueType(type: StorageType): boolean {
  if (type.encoding !== "inplace" || type.members !== undefined) {
    return false;
  }
  return (
    /^u?int[0-9]*$/.test(type.label) ||
    type.label === "address" ||
    type.label === "bool" ||
    /^bytes([1-9]|[12][0-9]|3[0-2])$/.test(type.label) ||
    type.label.startsWith("enum ")
  );
}

function isStructType(
  type: StorageType,
): type is StorageType & { members: readonly StorageItem[] } {
  return type.encoding === "inplace" && type.members !== undefined;
}

function isFixedArrayType(
  type: StorageType,
): type is StorageType & { base: string } {
  return type.encoding === "inplace" && type.base !== undefined;
}

function isDynamicArrayType(
  type: StorageType,
): type is StorageType & { base: string } {
  return type.encoding === "dynamic_array" && type.base !== undefined;
}

function isMappingType(
  type: StorageType,
): type is StorageType & { key: string; value: string } {
  return (
    type.encoding === "mapping" &&
    type.key !== undefined &&
    type.value !== undefined
  );
}

function isBytesType(type: StorageType): boolean {
  return type.encoding === "bytes";
}

type StorageItemPaths<
  Layout extends StorageLayout,
  Item extends StorageItem,
> = Item extends StorageItem
  ? StorageTypePaths<
      Layout,
      StorageTypeForItem<Layout, Item>,
      Extract<Item["label"], string>
    >
  : never;

type StorageTypePaths<
  Layout extends StorageLayout,
  Type,
  Prefix extends string,
> = Type extends {
  encoding: "mapping";
  key: infer Key extends string;
  value: infer Value extends string;
}
  ? MappingStoragePaths<Layout, Key, Value, Prefix>
  : Prefix | StorageTypeChildPaths<Layout, Type, Prefix>;

type MappingStoragePaths<
  Layout extends StorageLayout,
  Key extends string,
  Value extends string,
  Prefix extends string,
> =
  MappingKeyPath<Layout, Key> extends infer KeyPath extends string
    ? StorageTypePaths<
        Layout,
        StorageTypeForId<Layout, Value>,
        `${Prefix}[${KeyPath}]`
      >
    : never;

type MappingKeyPath<Layout extends StorageLayout, Key extends string> =
  StorageTypeForId<Layout, Key> extends infer KeyType extends StorageType
    ? KeyType["label"] extends "address"
      ? Hex.Hex
      : KeyType["label"] extends "bool"
        ? "true" | "false"
        : KeyType["label"] extends `uint${string}` | `int${string}`
          ? `${number}`
          : KeyType["label"] extends `bytes${number}`
            ? Hex.Hex
            : never
    : never;

type StorageTypeChildPaths<
  Layout extends StorageLayout,
  Type,
  Prefix extends string,
> = Type extends { members: readonly StorageItem[] }
  ? StructMemberPaths<Layout, Type["members"], Prefix>
  : Type extends {
        base: infer Base extends string;
        encoding: "dynamic_array";
      }
    ? StorageTypePaths<
        Layout,
        StorageTypeForId<Layout, Base>,
        `${Prefix}[${number}]`
      >
    : Type extends { base: infer Base extends string }
      ? Type extends { label: `${string}[${infer Length extends number}]` }
        ? FixedArrayIndex<Length> extends infer Index extends number
          ? StorageTypePaths<
              Layout,
              StorageTypeForId<Layout, Base>,
              `${Prefix}[${Index}]`
            >
          : never
        : never
      : never;

type StructMemberPaths<
  Layout extends StorageLayout,
  Members extends readonly StorageItem[],
  Prefix extends string,
> = Members[number] extends infer Member extends StorageItem
  ? Member extends StorageItem
    ? StorageTypePaths<
        Layout,
        StorageTypeForItem<Layout, Member>,
        `${Prefix}.${Extract<Member["label"], string>}`
      >
    : never
  : never;

type FixedArrayIndex<
  Length extends number,
  Acc extends readonly unknown[] = [],
> = number extends Length
  ? number
  : Acc["length"] extends Length
    ? never
    : Acc["length"] | FixedArrayIndex<Length, readonly [...Acc, unknown]>;

type StoragePathTypeToPrimitiveType<
  Layout extends StorageLayout,
  Type,
> = Type extends StorageType ? StorageTypeToPrimitiveType<Type, Layout> : Type;

type StorageTypeForPath<
  Layout extends StorageLayout,
  Path extends string | StoragePath,
> = Path extends string
  ? string extends Path
    ?
        | StorageType
        | CustomTypeError<"StoragePath root was not found in storage layout.">
    : StorageTypeForParsedPath<Layout, NormalizeStoragePath<Path>>
  : StorageTypeForParsedPath<Layout, NormalizeStoragePath<Path>>;

type StorageTypeForParsedPath<
  Layout extends StorageLayout,
  Path extends ParsedStoragePath,
> = Path extends {
  root: infer Root extends ExtractVariableNames<Layout>;
  segments: infer Segments extends readonly ParsedStoragePathSegment[];
}
  ? StoragePathSegmentsToStorageType<
      Layout,
      StorageTypeForItem<
        Layout,
        Extract<Layout["storage"][number], { label: Root }>
      >,
      Segments
    >
  : CustomTypeError<"StoragePath root was not found in storage layout.">;

type StoragePathSegmentsToStorageType<
  Layout extends StorageLayout,
  Type,
  Segments extends readonly ParsedStoragePathSegment[],
> = Segments extends readonly [
  infer Segment extends ParsedStoragePathSegment,
  ...infer Rest extends ParsedStoragePathSegment[],
]
  ? Segment extends { kind: "field"; name: infer Field extends string }
    ? Type extends { members: readonly StorageItem[] }
      ? StoragePathSegmentsToStorageType<
          Layout,
          StorageTypeForStructField<Layout, Type["members"], Field>,
          Rest
        >
      : CustomTypeError<"Storage path field requires a struct.">
    : StoragePathSegmentsToStorageType<
        Layout,
        SubscriptStorageType<Layout, Type>,
        Rest
      >
  : Type;

type SubscriptStorageType<Layout extends StorageLayout, Type> = Type extends {
  encoding: "mapping";
  value: infer Value extends string;
}
  ? StorageTypeForId<Layout, Value>
  : Type extends { base: infer Base extends string }
    ? StorageTypeForId<Layout, Base>
    : CustomTypeError<"Storage path subscript requires an array or mapping.">;

type IsStoragePathTypeSingleSlot<Type> = Type extends StorageType
  ? Type["encoding"] extends "mapping"
    ? CustomTypeError<`Unsupported type '${Type["label"]}'.`>
    : IsStorageTypeSingleSlot<Type>
  : Type;

type StorageTypeForStructField<
  Layout extends StorageLayout,
  Members extends readonly StorageItem[],
  Field extends string,
  Member extends StorageItem = Extract<Members[number], { label: Field }>,
> = [Member] extends [never]
  ? CustomTypeError<"Storage path field was not found in struct.">
  : StorageTypeForItem<Layout, Member>;

type StorageTypeForItem<
  Layout extends StorageLayout,
  Item extends StorageItem,
> = StorageTypeForId<Layout, Item["type"]>;

type StorageTypeForId<
  Layout extends StorageLayout,
  TypeId extends string,
> = TypeId extends keyof Layout["types"] ? Layout["types"][TypeId] : never;

type StorageTypeToPrimitiveType<
  Type extends StorageType,
  Layout extends StorageLayout,
> = Type["encoding"] extends "mapping"
  ? StorageMappingToPrimitiveType<Layout, Type>
  : Type extends { members: readonly StorageItem[] }
    ? Pretty<StorageMembersToObject<Layout, Type["members"]>>
    : Type["label"] extends `enum ${string}`
      ? number
      : Type["label"] extends AbiType
        ? AbiParameterToPrimitiveType<{ type: Type["label"] }>
        : Type["encoding"] extends "dynamic_array"
          ? Type extends { base: infer Base extends string }
            ? readonly StorageTypeToPrimitiveType<
                StorageTypeForId<Layout, Base>,
                Layout
              >[]
            : CustomTypeError<`Array type '${Type["label"]}' is missing base type.`>
          : Type extends { base: infer Base extends string }
            ? Type["label"] extends `${string}[${infer Length extends number}]`
              ? FixedArray<
                  StorageTypeToPrimitiveType<
                    StorageTypeForId<Layout, Base>,
                    Layout
                  >,
                  Length
                >
              : SolidityLabelToPrimitiveType<Type["label"]>
            : Type["label"] extends `${infer Element}[${infer Length extends number}]`
              ? FixedArray<SolidityLabelToPrimitiveType<Element>, Length>
              : SolidityLabelToPrimitiveType<Type["label"]>;

type StorageMappingToPrimitiveType<
  Layout extends StorageLayout,
  Type extends StorageType,
> = Type extends {
  key: infer Key extends string;
  value: infer Value extends string;
}
  ? [MappingKeyPath<Layout, Key>] extends [never]
    ? CustomTypeError<`Unsupported mapping key type '${StorageTypeForId<Layout, Key> extends StorageType ? StorageTypeForId<Layout, Key>["label"] : Key}'.`>
    : Record<
        MappingKeyPath<Layout, Key>,
        StorageTypeToPrimitiveType<StorageTypeForId<Layout, Value>, Layout>
      >
  : CustomTypeError<`Mapping type '${Type["label"]}' is missing key or value type.`>;

type StorageMembersToObject<
  Layout extends StorageLayout,
  Members extends readonly StorageItem[],
> = {
  [Member in Members[number] as Member["label"]]: StorageTypeToPrimitiveType<
    StorageTypeForItem<Layout, Member>,
    Layout
  >;
};

type SolidityLabelToPrimitiveType<Label extends string> = Label extends AbiType
  ? AbiParameterToPrimitiveType<{ type: Label }>
  : Label extends `enum ${string}`
    ? number
    : CustomTypeError<`Unsupported type '${Label}'.`>;

type IsStorageTypeSingleSlot<Type extends StorageType> =
  Type["numberOfBytes"] extends SingleSlotByteCount ? true : false;

type SingleSlotByteCount =
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "11"
  | "12"
  | "13"
  | "14"
  | "15"
  | "16"
  | "17"
  | "18"
  | "19"
  | "20"
  | "21"
  | "22"
  | "23"
  | "24"
  | "25"
  | "26"
  | "27"
  | "28"
  | "29"
  | "30"
  | "31"
  | "32";

type FixedArray<
  Element,
  Length extends number,
  Acc extends readonly Element[] = [],
> = Acc["length"] extends Length
  ? Acc
  : FixedArray<Element, Length, readonly [...Acc, Element]>;
