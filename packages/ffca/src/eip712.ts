import type { AbiParameter } from "abitype";
import { type Hex, TypedData } from "ox";
import type { FFCAMutationConfig } from "./config";

export function hashMutation(
  mutation: FFCAMutationConfig,
  name: string,
  args: unknown,
  domain: TypedData.Domain,
): Hex.Hex {
  const types: Record<string, { name: string; type: string }[]> = {};
  types[name] = mutation.params.map((p) => buildField(p, name, types));

  return TypedData.getSignPayload({
    domain,
    types,
    primaryType: name,
    message: args as Record<string, unknown>,
  });
}

function buildField(
  p: AbiParameter,
  parentTypeName: string,
  types: Record<string, { name: string; type: string }[]>,
): { name: string; type: string } {
  if (!p.name) {
    throw new Error(
      `hashMutation: every param must have a name (in ${parentTypeName})`,
    );
  }

  const isTuple = p.type === "tuple" || p.type.startsWith("tuple[");
  if (!isTuple) return { name: p.name, type: p.type };

  if (!("components" in p) || !p.components) {
    throw new Error(
      `hashMutation: tuple param missing components (${parentTypeName}.${p.name})`,
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
