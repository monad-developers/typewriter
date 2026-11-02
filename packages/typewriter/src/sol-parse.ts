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
  sourceUnit: number;
  visibility: string;
  storageLocation: string;
  parameters: { parameters: AstNode[] };
  returnParameters: { parameters: AstNode[] };
  kind: string;
  mutability: string;
  referencedDeclaration: number;
  /** The function a user-defined operator calls. */
  function: number;
  scope: number;
  expression: AstNode;
  memberName: string;
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

  const stateVariable = contract.nodes.find(
    (node) => node.nodeType === "VariableDeclaration" && node.name === "state",
  );
  const stateStruct =
    stateVariable && nodes.get(stateVariable.typeName.referencedDeclaration);
  if (stateStruct?.nodeType !== "StructDefinition") {
    throw new ConfigError({
      message: `${contract.name} must keep its state in a struct variable named \`state\``,
    });
  }

  for (const node of contract.nodes) {
    const isVariable = node.nodeType === "VariableDeclaration";
    if (
      isVariable &&
      node !== stateVariable &&
      node.mutability !== "constant"
    ) {
      throw new ConfigError({
        message: `${contract.name} must keep all its state in \`state\`, but declares \`${node.name}\``,
      });
    }
    const isEntrypoint =
      node.visibility === "public" || node.visibility === "external";
    if (
      isEntrypoint &&
      (isVariable ||
        (node.nodeType === "FunctionDefinition" && node.kind !== "constructor"))
    ) {
      throw new ConfigError({
        message: `${contract.name} must not add public or external functions or variables, but declares \`${node.name || node.kind}\``,
      });
    }
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

  const libraries = importedLibraries(unit, nodes);
  const mutations: SolidityApp["mutations"] = {};
  const entrypoints = contract.nodes.filter(
    (node) =>
      node.nodeType === "FunctionDefinition" && node.kind !== "constructor",
  );
  for (const [id, { name }] of mutationEnum.members.entries()) {
    if (Object.hasOwn(BUILTIN_MUTATIONS, name)) {
      throw new ConfigError({
        message: `Mutation.${name} is reserved by typewriter; rename it`,
      });
    }
    const matches = libraries.filter(
      (library) => library.name === `${name}Mutation`,
    );
    if (matches.length !== 1) {
      throw new ConfigError({
        message: `Mutation.${name} needs one library named ${name}Mutation in ${path} or its imports, but there are ${matches.length}`,
      });
    }
    const library = matches[0]!;
    const struct = library.nodes.find(
      (node) => node.nodeType === "StructDefinition" && node.name === name,
    );
    const signature = `function execute(${stateStruct.name} storage state, ${name} memory mutation, bytes32 accountID) internal`;
    const execute = library.nodes.find(
      (node) =>
        node.nodeType === "FunctionDefinition" &&
        node.name === "execute" &&
        node.visibility === "internal" &&
        node.returnParameters.parameters.length === 0 &&
        node.parameters.parameters
          .map(
            (param) =>
              `${param.typeName.referencedDeclaration ?? param.typeDescriptions.typeString} ${param.storageLocation}`,
          )
          .join() ===
          `${stateStruct.id} storage,${struct?.id} memory,bytes32 default`,
    );
    if (struct === undefined || execute === undefined) {
      throw new ConfigError({
        message: `${library.name} must declare \`struct ${name}\` with the mutation's params and \`${signature}\``,
      });
    }
    mutations[name] = { id, params: structParameters(struct, nodes) };
    entrypoints.push(execute);
  }
  checkDeterminism(
    entrypoints,
    nodes.get(contract.linearizedBaseContracts[1]!)!,
    nodes,
  );
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

const ENVIRONMENT_GLOBALS = new Set([
  "block",
  "msg",
  "tx",
  "gasleft",
  "blockhash",
  "blobhash",
]);
const ALLOWED_BLOCK_MEMBERS = new Set(["chainid", "number", "timestamp"]);
const ACCOUNT_MEMBERS = new Set([
  "balance",
  "code",
  "codehash",
  "call",
  "staticcall",
  "delegatecall",
  "send",
  "transfer",
]);

/**
 * Checks that the functions `entrypoints` can reach compute the same result in
 * typewriter's offchain EVM as onchain, which runs the app contract alone in
 * the last block it saw, with unlimited gas. Typewriter.sol's code is trusted.
 */
function checkDeterminism(
  entrypoints: AstNode[],
  typewriter: AstNode,
  nodes: Map<number, AstNode>,
) {
  const contractOf = new Map<number, AstNode>();
  for (const node of nodes.values()) {
    if (node.nodeType !== "ContractDefinition") continue;
    for (const member of node.nodes) contractOf.set(member.id, node);
  }
  const visited = new Set<number>();
  const pending = [...entrypoints];
  while (pending.length > 0) {
    const fn = pending.pop()!;
    if (visited.has(fn.id) || fn.scope === typewriter.scope) continue;
    visited.add(fn.id);
    const contract = contractOf.get(fn.id);
    const name = contract ? `${contract.name}.${fn.name}` : fn.name;
    const fail = (message: string): never => {
      throw new ConfigError({ message: `${name} ${message}` });
    };
    const environment = (node: AstNode) =>
      fail(
        `uses \`${describe(node)}\`, which can differ between offchain and onchain execution`,
      );
    const outside = (node: AstNode) =>
      fail(
        `uses \`${describe(node)}\`, but offchain, typewriter runs the app contract alone`,
      );

    for (const node of descendants(fn)) {
      if (node.nodeType === "InlineAssembly") {
        fail(
          "uses inline assembly, which typewriter can't check; write it in Solidity",
        );
      }
      if (
        node.nodeType === "Identifier" &&
        node.referencedDeclaration < 0 &&
        node.name !== "block" &&
        ENVIRONMENT_GLOBALS.has(node.name)
      ) {
        environment(node);
      }
      if (node.nodeType === "Identifier" && node.name === "selfdestruct") {
        outside(node);
      }
      if (node.nodeType === "MemberAccess") {
        const base = node.expression;
        if (
          base.nodeType === "Identifier" &&
          base.referencedDeclaration < 0 &&
          ENVIRONMENT_GLOBALS.has(base.name)
        ) {
          if (
            base.name !== "block" ||
            !ALLOWED_BLOCK_MEMBERS.has(node.memberName)
          ) {
            environment(node);
          }
        }
        if (
          base.typeDescriptions.typeString.startsWith("address") &&
          ACCOUNT_MEMBERS.has(node.memberName)
        ) {
          outside(node);
        }
      }
      if (
        node.nodeType === "FunctionCall" &&
        isExternalFunction(node.expression.typeDescriptions.typeString)
      ) {
        outside(node.expression);
      }
      if (
        node.nodeType === "NewExpression" &&
        node.typeName.nodeType === "UserDefinedTypeName"
      ) {
        outside(node);
      }

      const targetID = node.referencedDeclaration ?? node.function;
      const target = targetID === undefined ? undefined : nodes.get(targetID);
      if (
        target?.scope === typewriter.id &&
        (target.nodeType === "FunctionDefinition" ||
          (target.nodeType === "VariableDeclaration" &&
            target.mutability === "mutable"))
      ) {
        fail(
          `uses Typewriter's \`${target.name}\`, which only Typewriter may read or change`,
        );
      }
      if (
        target?.nodeType === "FunctionDefinition" ||
        target?.nodeType === "ModifierDefinition"
      ) {
        pending.push(target);
      }
    }
  }
}

/** Whether a solc function type string, e.g. `function (uint256) view external returns (bool)`, is external. */
function isExternalFunction(typeString: string): boolean {
  let flat = typeString;
  for (let previous = ""; previous !== flat; ) {
    previous = flat;
    flat = flat.replace(/\([^()]*\)/g, "()");
  }
  return /^function \(\)( \w+)* external\b/.test(flat);
}

/** Source-like text for an expression, e.g. `IERC20(…).transfer`. */
function describe(node: AstNode): string {
  switch (node.nodeType) {
    case "Identifier":
      return node.name;
    case "MemberAccess":
      return `${describe(node.expression)}.${node.memberName}`;
    case "FunctionCall":
      return `${describe(node.expression)}(…)`;
    case "ElementaryTypeNameExpression":
      return node.typeName.name;
    case "NewExpression":
      return `new ${node.typeName.typeDescriptions.typeString.replace(/^contract /, "")}`;
  }
  return "…";
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

/** The libraries defined in `unit` and the files it imports. */
function importedLibraries(
  unit: AstNode,
  nodes: Map<number, AstNode>,
): AstNode[] {
  const visited = new Set<number>();
  const libraries: AstNode[] = [];
  const visit = (unit: AstNode) => {
    if (visited.has(unit.id)) return;
    visited.add(unit.id);
    for (const node of unit.nodes) {
      if (node.contractKind === "library") libraries.push(node);
      if (node.nodeType === "ImportDirective") {
        visit(nodes.get(node.sourceUnit)!);
      }
    }
  };
  visit(unit);
  return libraries;
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
