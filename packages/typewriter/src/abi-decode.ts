import { type AbiParameters, Bytes, Hex } from "ox";

/** An ABI type: an array of `item`s, a tuple, or a value type like `uint8`. */
export type AbiType =
  | {
      kind: "array";
      item: AbiParameters.Parameter;
      /** Unset for a dynamic array. */
      length: number | undefined;
    }
  | { kind: "tuple"; components: readonly AbiParameters.Parameter[] }
  | { kind: "value"; type: string };

export function abiType(param: AbiParameters.Parameter): AbiType {
  const array = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (array !== null) {
    return {
      kind: "array",
      item: { ...param, type: array[1]! },
      length: array[2] === "" ? undefined : Number(array[2]),
    };
  }
  if (param.type === "tuple") {
    const { components } = param as {
      components: readonly AbiParameters.Parameter[];
    };
    return { kind: "tuple", components };
  }
  return { kind: "value", type: param.type };
}

/**
 * Decodes `data` as Solidity's `abi.decode(data, (...))` does from memory:
 * it throws where `abi.decode` reverts, and accepts what it accepts, such as
 * trailing bytes, offsets that overlap or leave gaps, and any padding after
 * `bytes` and `string`. `ox` instead keeps only the low bits of a dirty
 * integer or address, decodes invalid UTF-8 lossily, strips a leading BOM,
 * and stops after 8,192 reads of one position.
 *
 * Values have the shapes `ox` gives them, with lowercase addresses. The one
 * difference from `abi.decode`: a `string` that is not valid UTF-8 throws,
 * since no JS string holds its bytes.
 */
export function decodeAbiParameters(
  params: readonly AbiParameters.Parameter[],
  data: Hex.Hex,
): unknown[] {
  const bytes = Bytes.fromHex(data);
  return decodeComponents(params, bytes, 0, bytes.length);
}

/** `abi.decode` reverts on offsets and lengths above this. */
const MAX_OFFSET = 0xffff_ffff_ffff_ffffn;

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeComponents(
  components: readonly AbiParameters.Parameter[],
  data: Bytes.Bytes,
  start: number,
  end: number,
): unknown[] {
  const size = components.reduce((sum, c) => sum + headSize(c), 0);
  if (start > end || end - start < size) {
    throw new Error(`no ${size}-byte head at byte ${start}`);
  }
  let head = start;
  return components.map((component) => {
    const position = isDynamic(component) ? start + offset(data, head) : head;
    head += headSize(component);
    return decodeAt(component, data, position, end);
  });
}

/** Decodes `param` at `position`: its tail when dynamic, else in place. */
function decodeAt(
  param: AbiParameters.Parameter,
  data: Bytes.Bytes,
  position: number,
  end: number,
): unknown {
  const type = abiType(param);
  if (type.kind === "tuple") {
    const values = decodeComponents(type.components, data, position, end);
    if (
      type.components.length === 0 ||
      type.components.some(({ name }) => !name)
    ) {
      return values;
    }
    return Object.fromEntries(
      type.components.map((component, i) => [component.name, values[i]]),
    );
  }
  if (type.kind === "array") {
    assertWordAt(position, end);
    const length = type.length ?? Number(length64(data, position));
    const start = type.length === undefined ? position + 32 : position;
    const stride = headSize(type.item);
    if (BigInt(start) + BigInt(length) * BigInt(stride) > BigInt(end)) {
      throw new Error(`no ${length} ${type.item.type} at byte ${start}`);
    }
    return Array.from({ length }, (_, i) => {
      const element = start + i * stride;
      return decodeAt(
        type.item,
        data,
        isDynamic(type.item) ? start + offset(data, element) : element,
        end,
      );
    });
  }
  if (type.type === "bytes" || type.type === "string") {
    assertWordAt(position, end);
    const length = length64(data, position);
    if (BigInt(position) + 32n + length > BigInt(end)) {
      throw new Error(`no ${length} bytes at byte ${position + 32}`);
    }
    const value = data.subarray(position + 32, position + 32 + Number(length));
    return type.type === "bytes" ? Hex.fromBytes(value) : UTF8.decode(value);
  }
  return decodeValue(type.type, word(data, position), position);
}

/** Decodes a value type's word, throwing if it is dirty for `type`. */
function decodeValue(type: string, value: bigint, position: number): unknown {
  const dirty = () => new Error(`dirty ${type} at byte ${position}`);
  const integer = /^(u?)int(\d*)$/.exec(type);
  if (integer !== null) {
    const bits = Number(integer[2] || 256);
    const decoded =
      integer[1] === "u"
        ? BigInt.asUintN(bits, value)
        : BigInt.asIntN(bits, value);
    const word = integer[1] === "u" ? value : BigInt.asIntN(256, value);
    if (decoded !== word) throw dirty();
    return bits > 48 ? decoded : Number(decoded);
  }
  if (type === "address") {
    if (BigInt.asUintN(160, value) !== value) throw dirty();
    return Hex.fromNumber(value, { size: 20 });
  }
  if (type === "bool") {
    if (value > 1n) throw dirty();
    return value === 1n;
  }
  const bytes = /^bytes(\d+)$/.exec(type);
  if (bytes !== null) {
    const size = Number(bytes[1]);
    if (BigInt.asUintN(256 - 8 * size, value) !== 0n) throw dirty();
    return Hex.slice(Hex.fromNumber(value, { size: 32 }), 0, size);
  }
  throw new Error(`unsupported ABI type ${type}`);
}

function isDynamic(param: AbiParameters.Parameter): boolean {
  const type = abiType(param);
  if (type.kind === "array") {
    return type.length === undefined || isDynamic(type.item);
  }
  if (type.kind === "tuple") return type.components.some(isDynamic);
  return type.type === "bytes" || type.type === "string";
}

/** The size of `param` in the head of its tuple: an offset when dynamic. */
function headSize(param: AbiParameters.Parameter): number {
  if (isDynamic(param)) return 32;
  const type = abiType(param);
  if (type.kind === "array") return type.length! * headSize(type.item);
  if (type.kind === "tuple") {
    return type.components.reduce((sum, c) => sum + headSize(c), 0);
  }
  return 32;
}

/** The offset at `position`, which `abi.decode` caps at 64 bits. */
function offset(data: Bytes.Bytes, position: number): number {
  const value = word(data, position);
  if (value > MAX_OFFSET)
    throw new Error(`offset over 64 bits at byte ${position}`);
  return Number(value);
}

/** The length at `position`, which `abi.decode` caps at 64 bits. */
function length64(data: Bytes.Bytes, position: number): bigint {
  const value = word(data, position);
  if (value > MAX_OFFSET)
    throw new Error(`length over 64 bits at byte ${position}`);
  return value;
}

/** `abi.decode` reads a length or array only where a whole word fits. */
function assertWordAt(position: number, end: number) {
  if (position + 31 >= end) throw new Error(`no word at byte ${position}`);
}

function word(data: Bytes.Bytes, position: number): bigint {
  if (position + 32 > data.length) {
    throw new Error(`no word at byte ${position}`);
  }
  return Bytes.toBigInt(data.subarray(position, position + 32));
}
