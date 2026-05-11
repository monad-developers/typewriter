import type { AbiParameterToPrimitiveType, AbiType } from "abitype";
import {
  formatStoragePath,
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

export type Pretty<T> = { [K in keyof T]: T[K] } & unknown;

export type CustomTypeError<Message extends string> = [`Error: ${Message}`];

export type ExtractVariableNames<Layout extends StorageLayout> =
  Layout["storage"][number]["label"];

export type StorageLayoutToVariableTypes<Layout extends StorageLayout> =
  Pretty<{
    [Name in ExtractVariableNames<Layout>]: StorageLayoutToVariableType<
      Layout,
      Name
    >;
  }>;

export type StorageLayoutToVariableType<
  Layout extends StorageLayout,
  Name extends ExtractVariableNames<Layout>,
> = StorageTypeToPrimitiveType<
  StorageTypeForItem<
    Layout,
    Extract<Layout["storage"][number], { label: Name }>
  >,
  Layout
>;

export type StoragePathToPrimitiveType<
  Layout extends StorageLayout,
  Path extends string | StoragePath,
> = Path extends string
  ? StoragePathStringToPrimitiveType<Layout, Path>
  : Path extends {
        root: infer Root extends ExtractVariableNames<Layout>;
        segments: infer Segments;
      }
    ? Segments extends readonly []
      ? StorageLayoutToVariableType<Layout, Root>
      : StoragePathSegmentsToPrimitiveType<
          Layout,
          StorageTypeForItem<
            Layout,
            Extract<Layout["storage"][number], { label: Root }>
          >,
          Extract<Segments, readonly StoragePathSegment[]>
        >
    : CustomTypeError<"StoragePath root was not found in storage layout.">;

export type ExtractMappingVariableNames<Layout extends StorageLayout> = Extract<
  Layout["storage"][number],
  { type: MappingTypeIds<Layout> }
>["label"];

export type ExtractMappingType<
  Layout extends StorageLayout,
  Name extends ExtractMappingVariableNames<Layout>,
  KeyOrValue extends "key" | "value",
> = StorageTypeToPrimitiveType<
  StorageTypeForId<
    Layout,
    Extract<
      StorageTypeForItem<
        Layout,
        Extract<Layout["storage"][number], { label: Name }>
      >[KeyOrValue],
      string
    >
  >,
  Layout
>;

export type IsVariableSingleSlot<
  Layout extends StorageLayout,
  Name extends ExtractVariableNames<Layout>,
> = IsStorageTypeSingleSlot<
  StorageTypeForItem<
    Layout,
    Extract<Layout["storage"][number], { label: Name }>
  >
>;

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

type StoragePathStringToPrimitiveType<
  Layout extends StorageLayout,
  Path extends string,
> = Path extends `${string}[${string}]${string}`
  ? CustomTypeError<"Subscript storage path string typing is not implemented yet.">
  : Path extends `${infer Root}.${infer Rest}`
    ? Root extends ExtractVariableNames<Layout>
      ? StoragePathTailToPrimitiveType<
          Layout,
          StorageTypeForItem<
            Layout,
            Extract<Layout["storage"][number], { label: Root }>
          >,
          Rest
        >
      : CustomTypeError<"Storage path root was not found in storage layout.">
    : Path extends ExtractVariableNames<Layout>
      ? StorageLayoutToVariableType<Layout, Path>
      : CustomTypeError<"Storage path root was not found in storage layout.">;

type StoragePathTailToPrimitiveType<
  Layout extends StorageLayout,
  Type extends StorageType,
  Tail extends string,
> = Type extends { members: readonly StorageItem[] }
  ? Tail extends `${infer Field}.${infer Rest}`
    ? StoragePathTailToPrimitiveType<
        Layout,
        StorageTypeForStructField<Layout, Type["members"], Field>,
        Rest
      >
    : StorageTypeToPrimitiveType<
        StorageTypeForStructField<Layout, Type["members"], Tail>,
        Layout
      >
  : CustomTypeError<"Storage path field requires a struct.">;

type StoragePathSegmentsToPrimitiveType<
  Layout extends StorageLayout,
  Type extends StorageType,
  Segments extends readonly StoragePathSegment[],
> = Segments extends readonly [
  infer Segment extends StoragePathSegment,
  ...infer Rest extends StoragePathSegment[],
]
  ? Segment extends { kind: "field"; name: infer Field extends string }
    ? Type extends { members: readonly StorageItem[] }
      ? StoragePathSegmentsToPrimitiveType<
          Layout,
          StorageTypeForStructField<Layout, Type["members"], Field>,
          Rest
        >
      : CustomTypeError<"Storage path field requires a struct.">
    : CustomTypeError<"Subscript StoragePath typing is not implemented yet.">
  : StorageTypeToPrimitiveType<Type, Layout>;

type StorageTypeForPath<
  Layout extends StorageLayout,
  Path extends string | StoragePath,
> = Path extends string
  ? StoragePathStringToStorageType<Layout, Path>
  : Path extends {
        root: infer Root extends ExtractVariableNames<Layout>;
        segments: infer Segments;
      }
    ? Segments extends readonly []
      ? StorageTypeForItem<
          Layout,
          Extract<Layout["storage"][number], { label: Root }>
        >
      : StoragePathSegmentsToStorageType<
          Layout,
          StorageTypeForItem<
            Layout,
            Extract<Layout["storage"][number], { label: Root }>
          >,
          Extract<Segments, readonly StoragePathSegment[]>
        >
    : CustomTypeError<"StoragePath root was not found in storage layout.">;

type StoragePathStringToStorageType<
  Layout extends StorageLayout,
  Path extends string,
> = string extends Path
  ?
      | StorageType
      | CustomTypeError<"StoragePath root was not found in storage layout.">
  : Path extends `${string}[${string}]${string}`
    ? CustomTypeError<"Subscript storage path string typing is not implemented yet.">
    : Path extends `${infer Root}.${infer Rest}`
      ? Root extends ExtractVariableNames<Layout>
        ? StoragePathTailToStorageType<
            Layout,
            StorageTypeForItem<
              Layout,
              Extract<Layout["storage"][number], { label: Root }>
            >,
            Rest
          >
        : CustomTypeError<"Storage path root was not found in storage layout.">
      : Path extends ExtractVariableNames<Layout>
        ? StorageTypeForItem<
            Layout,
            Extract<Layout["storage"][number], { label: Path }>
          >
        : CustomTypeError<"Storage path root was not found in storage layout.">;

type StoragePathTailToStorageType<
  Layout extends StorageLayout,
  Type extends StorageType,
  Tail extends string,
> = Type extends { members: readonly StorageItem[] }
  ? Tail extends `${infer Field}.${infer Rest}`
    ? StoragePathTailToStorageType<
        Layout,
        StorageTypeForStructField<Layout, Type["members"], Field>,
        Rest
      >
    : StorageTypeForStructField<Layout, Type["members"], Tail>
  : CustomTypeError<"Storage path field requires a struct.">;

type StoragePathSegmentsToStorageType<
  Layout extends StorageLayout,
  Type extends StorageType,
  Segments extends readonly StoragePathSegment[],
> = Segments extends readonly [
  infer Segment extends StoragePathSegment,
  ...infer Rest extends StoragePathSegment[],
]
  ? Segment extends { kind: "field"; name: infer Field extends string }
    ? Type extends { members: readonly StorageItem[] }
      ? StoragePathSegmentsToStorageType<
          Layout,
          StorageTypeForStructField<Layout, Type["members"], Field>,
          Rest
        >
      : CustomTypeError<"Storage path field requires a struct.">
    : CustomTypeError<"Subscript StoragePath typing is not implemented yet.">
  : Type;

type IsStoragePathTypeSingleSlot<Type> = Type extends StorageType
  ? IsStorageTypeSingleSlot<Type>
  : Type;

type StorageTypeForStructField<
  Layout extends StorageLayout,
  Members extends readonly StorageItem[],
  Field extends string,
  Member extends StorageItem = Extract<Members[number], { label: Field }>,
> = [Member] extends [never] ? never : StorageTypeForItem<Layout, Member>;

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
  ? CustomTypeError<`Unsupported type '${Type["label"]}'.`>
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

type MappingTypeIds<Layout extends StorageLayout> = {
  [TypeId in keyof Layout["types"]]: Layout["types"][TypeId]["encoding"] extends "mapping"
    ? TypeId
    : never;
}[keyof Layout["types"]];

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
