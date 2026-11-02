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
  canonicalName: string;
  abstract: boolean;
  linearizedBaseContracts: number[];
  nodes: AstNode[];
  members: AstNode[];
  sourceUnit: number;
  referencedDeclaration: number;
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

  const mutationEnum = contract.nodes.find(
    (node) => node.nodeType === "EnumDefinition" && node.name === "Mutation",
  );
  if (mutationEnum === undefined) {
    throw new ConfigError({
      message: `${contract.name} must declare \`enum Mutation\` inside the contract, with a member for each mutation`,
    });
  }
  if (mutationEnum.members.length > FIRST_BUILTIN_MUTATION_ID) {
    throw new ConfigError({
      message: `Mutation has ${mutationEnum.members.length} members, but typewriter reserves IDs from ${FIRST_BUILTIN_MUTATION_ID}; it can have at most ${FIRST_BUILTIN_MUTATION_ID}`,
    });
  }

  const structs = importedStructs(unit, nodes);
  const mutations: SolidityApp["mutations"] = {};
  for (const [id, member] of mutationEnum.members.entries()) {
    if (Object.hasOwn(BUILTIN_MUTATIONS, member.name)) {
      throw new ConfigError({
        message: `Mutation.${member.name} is reserved by typewriter; rename it`,
      });
    }
    const matches = structs.filter(({ name }) => name === member.name);
    if (matches.length !== 1) {
      throw new ConfigError({
        message: `Mutation.${member.name} takes its params from a struct named ${member.name}, but ${path} and its imports define ${matches.length === 0 ? "none" : matches.map(({ canonicalName }) => canonicalName).join(", ")}`,
      });
    }
    mutations[member.name] = {
      id,
      params: structParameters(matches[0]!, nodes),
    };
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
      node.linearizedBaseContracts.some(
        (id) => nodes.get(id)!.name === "Typewriter",
      ),
  );
  if (contracts.length !== 1) {
    throw new ConfigError({
      message: `${path} must define one contract that inherits Typewriter, but defines ${contracts.length === 0 ? "none" : contracts.map(({ name }) => name).join(", ")}`,
    });
  }
  const contract = contracts[0]!;
  const bases = contract.linearizedBaseContracts.slice(1);
  if (bases.length !== 1 || nodes.get(bases[0]!)!.name !== "Typewriter") {
    throw new ConfigError({
      message: `${contract.name} must inherit only Typewriter, but inherits ${bases.map((id) => nodes.get(id)!.name).join(", ")}`,
    });
  }
  if (contract.abstract) {
    throw new ConfigError({
      message: `${contract.name} must not be abstract`,
    });
  }
  return contract;
}

/** The structs defined in `unit` and the files it imports. */
function importedStructs(
  unit: AstNode,
  nodes: Map<number, AstNode>,
): AstNode[] {
  const visited = new Set<number>();
  const structs: AstNode[] = [];
  const visit = (unit: AstNode) => {
    if (visited.has(unit.id)) return;
    visited.add(unit.id);
    for (const node of descendants(unit)) {
      if (node.nodeType === "StructDefinition") structs.push(node);
      if (node.nodeType === "ImportDirective") {
        visit(nodes.get(node.sourceUnit)!);
      }
    }
  };
  visit(unit);
  return structs;
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
