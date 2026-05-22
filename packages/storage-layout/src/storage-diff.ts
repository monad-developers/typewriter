import type {
  StorageLayout,
  StorageVariableToPrimitiveType,
} from "./storage-layout";
import type {
  AccountStorage,
  ConcreteStorageVariable,
  SlotWrites,
} from "./types";

export type StorageSlotDiff = {
  readonly pre: AccountStorage;
  readonly post: AccountStorage;
};

export type StorageSlotWriteDiff = {
  readonly pre: SlotWrites;
  readonly post: SlotWrites;
};

type StorageVariableDiffValues<Layout extends StorageLayout> =
  string extends Layout["storage"][number]["label"]
    ? Record<string, unknown>
    : Pretty<
        UnionToIntersection<
          ConcreteStorageVariable<Layout> extends infer Path extends string
            ? {
                readonly [Key in Path]?: StorageVariableToPrimitiveType<
                  Layout,
                  Key
                >;
              }
            : never
        >
      >;

type Pretty<T> = { [K in keyof T]: T[K] } & unknown;

type UnionToIntersection<T> = (
  T extends unknown
    ? (value: T) => void
    : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

export type StorageVariableDiff<Layout extends StorageLayout = StorageLayout> =
  {
    readonly pre: StorageVariableDiffValues<Layout>;
    readonly post: StorageVariableDiffValues<Layout>;
  };
