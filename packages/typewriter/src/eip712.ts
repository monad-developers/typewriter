import type { AbiParameter } from "abitype";
import { type Hex, TypedData } from "ox";
import type { MutationConfig } from "./config";

export const FFCA_DOMAIN = {
  name: "FFCA",
  version: "1",
} as const;

export function hashMutationEip712(
  mutation: MutationConfig,
  name: string,
  params: unknown,
  domain: TypedData.Domain,
): Hex.Hex {
  return TypedData.getSignPayload({
    domain,
    types: buildEip712Types(mutation, name),
    primaryType: name,
    message: params as Record<string, unknown>,
  });
}

export function buildEip712Types(
  mutation: MutationConfig,
  name: string,
): Record<string, { name: string; type: string }[]> {
  const types: Record<string, { name: string; type: string }[]> = {};
  types[name] = mutation.params.map((p) => buildField(p, name, types));
  return types;
}

function buildField(
  p: AbiParameter,
  parentTypeName: string,
  types: Record<string, { name: string; type: string }[]>,
): { name: string; type: string } {
  if (!p.name) {
    throw new Error(`every param must have a name (in ${parentTypeName})`);
  }

  const isTuple = p.type === "tuple" || p.type.startsWith("tuple[");
  if (!isTuple) return { name: p.name, type: p.type };

  if (!("components" in p) || !p.components) {
    throw new Error(
      `tuple param missing components (${parentTypeName}.${p.name})`,
    );
  }

  const structName =
    typeof p.internalType === "string" && p.internalType.startsWith("struct ")
      ? p.internalType.slice("struct ".length).replace(/\[\]$/, "")
      : `${parentTypeName}_${p.name}`;

  if (!(structName in types)) {
    types[structName] = [];
    types[structName] = p.components.map((c) =>
      buildField(c, structName, types),
    );
  }

  const arraySuffix = p.type.slice("tuple".length);
  return { name: p.name, type: `${structName}${arraySuffix}` };
}
