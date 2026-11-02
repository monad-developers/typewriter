import { Hex } from "ox";
import type { Abi, AbiParameter } from "viem";
import {
  ConfigError,
  type ResolvedTypewriterMutationConfig,
  type StorageConfig,
} from "./config";
import {
  BUILTIN_MUTATIONS,
  FIRST_BUILTIN_MUTATION_ID,
} from "./typewriter-constants";

/** The parts of solc's standard JSON output that typewriter reads. */
export type SolcOutput = {
  sources: { [path: string]: { ast: AstNode } };
  contracts: {
    [path: string]: {
      [name: string]: {
        abi: Abi;
        storageLayout: StorageConfig;
        evm: { bytecode: { object: string } };
      };
    };
  };
};

/** A solc AST node. Only the fields of its `nodeType` are set. */
type AstNode = {
  id: number;
  nodeType: string;
  name: string;
  abstract: boolean;
  contractKind: string;
  linearizedBaseContracts: number[];
  nodes: AstNode[];
  members: AstNode[];
  implemented: boolean;
  parameters: { parameters: AstNode[] };
  body: AstNode;
  condition: AstNode;
  trueBody: AstNode;
  operator: string;
  leftExpression: AstNode;
  rightExpression: AstNode;
  kind: string;
  expression: AstNode;
  arguments: AstNode[];
  memberName: string;
  referencedDeclaration: number;
  components: AstNode[];
  typeName: AstNode;
  baseType: AstNode;
  underlyingType: AstNode;
  typeDescriptions: { typeString: string };
};

export type SolidityApp = {
  contractName: string;
  abi: Abi;
  /** Creation bytecode, without constructor arguments. */
  bytecode: Hex.Hex;
  storageLayout: StorageConfig;
  mutations: { [name: string]: ResolvedTypewriterMutationConfig };
};

/** Reads the typewriter app defined in `path` from the solc output that compiled it. */
export function parseSolidity(output: SolcOutput, path: string): SolidityApp {
  const unit = output.sources[path]?.ast;
  if (unit === undefined) {
    throw new ConfigError({ message: `${path} was not compiled` });
  }
  const nodes = new Map<number, AstNode>();
  for (const source of Object.values(output.sources)) {
    for (const node of descendants(source.ast)) nodes.set(node.id, node);
  }

  const contract = findAppContract(unit, nodes, path);
  const { abi, storageLayout, evm } = output.contracts[path]![contract.name]!;

  const constructorInputs =
    abi.find((item) => item.type === "constructor")?.inputs ?? [];
  if (constructorInputs.map((input) => input.type).join() !== "address") {
    throw new ConfigError({
      message: `${contract.name} must declare \`constructor(address scheduler)\` and pass it to \`Typewriter(scheduler)\`, but its constructor takes (${constructorInputs.map((input) => input.type).join(", ")})`,
    });
  }

  const state = storageLayout.storage.find((item) => item.label === "state");
  if (
    state === undefined ||
    storageLayout.types[state.type]?.members === undefined
  ) {
    throw new ConfigError({
      message: `${contract.name} must keep its state in a struct variable named \`state\``,
    });
  }

  const bytecode = `0x${evm.bytecode.object}`;
  if (!Hex.validate(bytecode, { strict: true })) {
    throw new ConfigError({
      message: `${contract.name} calls an external library function, which typewriter can't execute offchain; make the library's functions internal`,
    });
  }

  const inherited = contract.linearizedBaseContracts.flatMap(
    (id) => nodes.get(id)!.nodes,
  );
  const mutationEnum = inherited.find(
    (node) => node.nodeType === "EnumDefinition" && node.name === "Mutation",
  );
  if (mutationEnum === undefined) {
    throw new ConfigError({
      message: `${contract.name} must declare \`enum Mutation\` inside the contract or a base contract, with a member for each mutation`,
    });
  }
  // A contract that isn't abstract implements every function.
  const dispatch = inherited.find(
    (node) =>
      node.nodeType === "FunctionDefinition" &&
      node.name === "dispatch" &&
      node.implemented,
  )!;
  const [mutationParam, dataParam] = dispatch.parameters.parameters;

  const branches = new Map<number, AstNode>();
  for (const node of descendants(dispatch.body)) {
    if (node.nodeType !== "IfStatement") continue;
    const member = comparedMember(node.condition, mutationParam!.id);
    if (!mutationEnum.members.some(({ id }) => id === member)) continue;
    if (branches.has(member!)) {
      throw new ConfigError({
        message: `${contract.name}.dispatch has more than one branch for Mutation.${nodes.get(member!)!.name}`,
      });
    }
    branches.set(member!, node.trueBody);
  }

  const mutations: SolidityApp["mutations"] = {};
  for (const [id, member] of mutationEnum.members.entries()) {
    if (Object.hasOwn(BUILTIN_MUTATIONS, member.name)) {
      throw new ConfigError({
        message: `Mutation.${member.name} is reserved by typewriter; rename it`,
      });
    }
    if (id >= FIRST_BUILTIN_MUTATION_ID) {
      throw new ConfigError({
        message: `Mutation.${member.name} has ID ${id}, but typewriter reserves IDs from ${FIRST_BUILTIN_MUTATION_ID}; Mutation can have at most ${FIRST_BUILTIN_MUTATION_ID} members`,
      });
    }
    const branch = branches.get(member.id);
    if (branch === undefined) {
      throw new ConfigError({
        message: `${contract.name}.dispatch has no branch for Mutation.${member.name}; add \`if (mutation == uint8(Mutation.${member.name}))\``,
      });
    }
    const struct = decodedStruct(branch, dataParam!.id, nodes);
    if (struct === undefined) {
      throw new ConfigError({
        message: `The Mutation.${member.name} branch of ${contract.name}.dispatch must decode mutationData into a struct once, as \`abi.decode(mutationData, (${member.name}))\``,
      });
    }
    mutations[member.name] = { id, params: structParameters(struct, nodes) };
  }
  for (const [name, { id, params }] of Object.entries(BUILTIN_MUTATIONS)) {
    mutations[name] = { id, params };
  }

  return {
    contractName: contract.name,
    abi,
    bytecode,
    storageLayout,
    mutations,
  };
}

function* descendants(value: unknown): Generator<AstNode> {
  if (typeof value !== "object" || value === null) return;
  if ("nodeType" in value) yield value as AstNode;
  for (const child of Object.values(value)) yield* descendants(child);
}

function findAppContract(
  unit: AstNode,
  nodes: Map<number, AstNode>,
  path: string,
): AstNode {
  const contracts = unit.nodes.filter(
    (node) =>
      node.nodeType === "ContractDefinition" &&
      node.contractKind === "contract" &&
      !node.abstract &&
      node.linearizedBaseContracts.some(
        (id) => nodes.get(id)!.name === "Typewriter",
      ),
  );
  if (contracts.length !== 1) {
    throw new ConfigError({
      message: `${path} must define one contract that inherits Typewriter and isn't abstract, but defines ${contracts.length === 0 ? "none" : contracts.map(({ name }) => name).join(", ")}`,
    });
  }
  return contracts[0]!;
}

/** `T(x)` → `x`, for any number of type conversions. */
function unwrap(node: AstNode): AstNode {
  return node.nodeType === "FunctionCall" && node.kind === "typeConversion"
    ? unwrap(node.arguments[0]!)
    : node;
}

function references(node: AstNode, declaration: number): boolean {
  return (
    node.nodeType === "Identifier" && node.referencedDeclaration === declaration
  );
}

/** The `Mutation` member that `mutation == uint8(Mutation.X)` compares with. */
function comparedMember(
  condition: AstNode,
  mutationParam: number,
): number | undefined {
  if (condition.nodeType !== "BinaryOperation" || condition.operator !== "==") {
    return undefined;
  }
  const left = unwrap(condition.leftExpression);
  const right = unwrap(condition.rightExpression);
  const other = references(left, mutationParam)
    ? right
    : references(right, mutationParam)
      ? left
      : undefined;
  return other?.nodeType === "MemberAccess"
    ? other.referencedDeclaration
    : undefined;
}

/** The struct of the one `abi.decode(mutationData, (Struct))` in `branch`. */
function decodedStruct(
  branch: AstNode,
  dataParam: number,
  nodes: Map<number, AstNode>,
): AstNode | undefined {
  const decodes = [...descendants(branch)].filter(
    (node) =>
      node.nodeType === "FunctionCall" &&
      node.expression.nodeType === "MemberAccess" &&
      node.expression.memberName === "decode" &&
      node.expression.expression.name === "abi" &&
      references(node.arguments[0]!, dataParam),
  );
  if (decodes.length !== 1) return undefined;
  const types = decodes[0]!.arguments[1]!;
  const type =
    types.nodeType === "TupleExpression" && types.components.length === 1
      ? types.components[0]!
      : types;
  const struct = nodes.get(type.referencedDeclaration);
  return struct?.nodeType === "StructDefinition" ? struct : undefined;
}

function structParameters(
  struct: AstNode,
  nodes: Map<number, AstNode>,
): AbiParameter[] {
  return struct.members.map((member) =>
    abiParameter(member.name, member.typeName, nodes, struct.name),
  );
}

function abiParameter(
  name: string,
  typeName: AstNode,
  nodes: Map<number, AstNode>,
  structName: string,
): AbiParameter {
  const { typeString } = typeName.typeDescriptions;
  if (typeName.nodeType === "ElementaryTypeName") {
    return { name, type: typeString.replace(/ payable$/, "") };
  }
  if (typeName.nodeType === "ArrayTypeName") {
    const item = abiParameter(name, typeName.baseType, nodes, structName);
    // The type string has the length of `T[N]` with `N` a constant.
    return { ...item, type: `${item.type}${/\[\d*\]$/.exec(typeString)![0]}` };
  }
  const declaration = nodes.get(typeName.referencedDeclaration);
  switch (declaration?.nodeType) {
    case "EnumDefinition":
      return { name, type: "uint8" };
    case "ContractDefinition":
      return { name, type: "address" };
    case "UserDefinedValueTypeDefinition":
      return abiParameter(name, declaration.underlyingType, nodes, structName);
    case "StructDefinition":
      return {
        name,
        type: "tuple",
        components: structParameters(declaration, nodes),
      };
  }
  throw new ConfigError({
    message: `${structName}.${name} has type ${typeString}, which can't be a mutation param`,
  });
}

/** The `.sol.d.ts` that types an app's entrypoint import. */
export function formatSolidityDeclaration(app: SolidityApp): string {
  const metadata = typeLiteral({
    storageLayout: app.storageLayout,
    mutations: app.mutations,
  });
  return `// Generated by typewriter from ${app.contractName}.sol. Do not edit by hand.

declare const entrypoint: import("typewriter").TypewriterSolidityEntrypoint<${metadata}>;
export default entrypoint;
`;
}

function typeLiteral(value: unknown, level = 0): string {
  const indent = "  ".repeat(level);
  if (Array.isArray(value)) {
    if (value.length === 0) return "readonly []";
    const items = value.map(
      (item) => `${indent}  ${typeLiteral(item, level + 1)},\n`,
    );
    return `readonly [\n${items.join("")}${indent}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const properties = entries.map(
      ([key, child]) =>
        `${indent}  readonly ${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${typeLiteral(child, level + 1)};\n`,
    );
    return `{\n${properties.join("")}${indent}}`;
  }
  return JSON.stringify(value);
}
