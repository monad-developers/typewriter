import { $ } from "bun";
import type { Abi, AbiParameter } from "viem";
import type {
  ResolvedTypewriterMutationConfig,
  SequencingConfig,
  StorageConfig,
  TypewriterConfig,
} from "./config";
import { BUILTIN_MUTATIONS, buildInternalApp } from "./config";
import type { InternalApp } from "./internal";

type JsonObject = Record<string, unknown>;

type AstNode = JsonObject & {
  readonly id?: number;
  readonly name?: string;
  readonly nodeType?: string;
  readonly src?: string;
  readonly absolutePath?: string;
  readonly arguments?: readonly AstNode[];
  readonly baseContracts?: readonly AstNode[];
  readonly baseName?: unknown;
  readonly baseType?: unknown;
  readonly body?: unknown;
  readonly condition?: unknown;
  readonly declarations?: readonly AstNode[];
  readonly expression?: unknown;
  readonly falseBody?: unknown;
  readonly initialValue?: unknown;
  readonly kind?: string;
  readonly leftExpression?: unknown;
  readonly length?: unknown;
  readonly memberName?: string;
  readonly members?: readonly AstNode[];
  readonly namePath?: string;
  readonly nodes?: readonly AstNode[];
  readonly operator?: string;
  readonly referencedDeclaration?: number;
  readonly rightExpression?: unknown;
  readonly statements?: readonly AstNode[];
  readonly trueBody?: unknown;
  readonly typeDescriptions?: unknown;
  readonly typeString?: string;
  readonly typeName?: unknown;
  readonly value?: string;
};

type StorageLayout = StorageConfig;
type StorageType = StorageLayout["types"][string];

export type TypewriterSolidityEntrypoint<metadata = unknown> = string & {
  readonly __typewriterSolidityEntrypoint?: metadata;
};

type SolidityArtifact = {
  readonly abi?: unknown;
  readonly ast?: AstNode;
  readonly storageLayout?: StorageLayout;
};

type FoundryProject = {
  readonly root: string;
  readonly out: string;
};

type ParsedMutation = {
  readonly enumName: string;
  readonly id: number;
  readonly params: readonly AbiParameter[];
};

type ParsedSolidityMetadata = {
  readonly contractName: string;
  readonly abi: Abi;
  readonly storageLayout: StorageLayout;
  readonly mutations: readonly ParsedMutation[];
};

function isObject(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, name: string): AstNode {
  if (!isObject(value)) throw new Error(`${name} must be an object`);
  return value;
}

function asAstNode(value: unknown, name: string): AstNode {
  const node = requireObject(value, name) as AstNode;
  if (typeof node.nodeType !== "string") {
    throw new Error(`${name} is missing nodeType`);
  }
  return node;
}

function asAstNodes(value: unknown): readonly AstNode[] {
  if (!Array.isArray(value)) return [];
  return value.map((node, index) => asAstNode(node, `AST node ${index}`));
}

function displayPath(path: string): string {
  const cwd = `${process.cwd()}/`;
  return path.startsWith(cwd) ? path.slice(cwd.length) : path;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function joinPath(...parts: readonly string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join("/")
    .replaceAll(/\/+/g, "/");
}

function indent(level: number): string {
  return "  ".repeat(level);
}

function propertyName(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

function typeLiteralForValue(value: unknown, level = 0): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";

  if (Array.isArray(value)) {
    if (value.length === 0) return "readonly []";
    const items = value
      .map(
        (item) =>
          `${indent(level + 1)}${typeLiteralForValue(item, level + 1)},`,
      )
      .join("\n");
    return `readonly [\n${items}\n${indent(level)}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const properties = entries
      .map(
        ([key, child]) =>
          `${indent(level + 1)}readonly ${propertyName(key)}: ${typeLiteralForValue(child, level + 1)};`,
      )
      .join("\n");
    return `{\n${properties}\n${indent(level)}}`;
  }

  return "unknown";
}

async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

function outForProfile(contents: string, profile: string): string | undefined {
  let inProfile = false;
  for (const rawLine of contents.split("\n")) {
    const sectionMatch = rawLine.match(/^\s*\[([^\]]+)\]/);
    if (sectionMatch !== null) {
      inProfile = sectionMatch[1]?.trim() === `profile.${profile}`;
      continue;
    }
    if (!inProfile) continue;
    const outMatch = rawLine.match(/^\s*out\s*=\s*"([^"]+)"\s*$/);
    if (outMatch !== null) return outMatch[1];
  }
  return undefined;
}

function foundryOutDir(contents: string): string {
  // Foundry resolves config from the active profile, falling back to the
  // default profile and finally Foundry's built-in `out`. Match that order so
  // a non-default profile declaring `out` first in the file isn't picked up.
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket access.
  const activeProfile = process.env["FOUNDRY_PROFILE"] ?? "default";
  return (
    outForProfile(contents, activeProfile) ??
    outForProfile(contents, "default") ??
    "out"
  );
}

async function findFoundryProject(entrypoint: string): Promise<FoundryProject> {
  let current = dirname(entrypoint);
  while (true) {
    const configPath = joinPath(current, "foundry.toml");
    if (await fileExists(configPath)) {
      const contents = await Bun.file(configPath).text();
      return { root: current, out: foundryOutDir(contents) };
    }

    const next = dirname(current);
    if (next === current || current === "") {
      throw new Error(
        `Could not find foundry.toml for Solidity entrypoint ${displayPath(entrypoint)}`,
      );
    }
    current = next;
  }
}

async function buildFoundryProject(project: FoundryProject): Promise<void> {
  try {
    await $`forge build --ast --extra-output storageLayout --force`
      .cwd(project.root)
      .quiet();
  } catch (cause) {
    throw new Error(`forge build failed for ${project.root}`, { cause });
  }
}

async function readArtifact(path: string): Promise<SolidityArtifact> {
  const artifact = await Bun.file(path).json();
  return requireObject(artifact, `artifact ${path}`) as SolidityArtifact;
}

function requireArtifactAbi(artifact: SolidityArtifact, path: string): Abi {
  if (!Array.isArray(artifact.abi)) {
    throw new Error(`missing ABI in artifact ${path}`);
  }
  return artifact.abi as Abi;
}

async function readEntrypointAst(
  project: FoundryProject,
  entrypoint: string,
): Promise<AstNode> {
  const artifactDir = joinPath(project.root, project.out, basename(entrypoint));
  const glob = new Bun.Glob("*.json");
  for await (const artifactName of glob.scan({ cwd: artifactDir })) {
    const artifact = await readArtifact(joinPath(artifactDir, artifactName));
    if (artifact.ast !== undefined)
      return asAstNode(artifact.ast, "artifact ast");
  }
  throw new Error(`missing compiler AST for ${displayPath(entrypoint)}`);
}

async function readAllSourceAsts(
  project: FoundryProject,
): Promise<readonly AstNode[]> {
  const outDir = joinPath(project.root, project.out);
  const glob = new Bun.Glob("**/*.json");
  const asts = new Map<string, AstNode>();
  for await (const artifactName of glob.scan({ cwd: outDir })) {
    const artifact = await readArtifact(joinPath(outDir, artifactName));
    if (artifact.ast === undefined) continue;
    const ast = asAstNode(artifact.ast, "artifact ast");
    const absolutePath = ast.absolutePath;
    if (typeof absolutePath === "string") asts.set(absolutePath, ast);
  }
  return [...asts.values()];
}

async function readReachableSourceAsts(
  project: FoundryProject,
  entrypointAst: AstNode,
): Promise<readonly AstNode[]> {
  const allAsts = await readAllSourceAsts(project);
  const byPath = new Map(
    allAsts.flatMap((ast) =>
      typeof ast.absolutePath === "string"
        ? [[ast.absolutePath, ast] as const]
        : [],
    ),
  );
  const reachable = new Map<string, AstNode>();

  const visit = (ast: AstNode) => {
    if (typeof ast.absolutePath !== "string") return;
    if (reachable.has(ast.absolutePath)) return;
    reachable.set(ast.absolutePath, ast);

    for (const directive of asAstNodes(ast.nodes).filter(
      (node) => node.nodeType === "ImportDirective",
    )) {
      if (typeof directive.absolutePath !== "string") continue;
      const imported = byPath.get(directive.absolutePath);
      if (imported !== undefined) visit(imported);
    }
  };

  visit(entrypointAst);
  return [...reachable.values()];
}

function findEntrypointContract(entrypoint: string, ast: AstNode): AstNode {
  const contracts = asAstNodes(ast.nodes).filter(
    (node) => node.nodeType === "ContractDefinition",
  );
  const typewriterContracts = contracts.filter((contract) => {
    const baseContracts = asAstNodes(contract.baseContracts);
    return baseContracts.some((base) => {
      const baseName = requireObject(base.baseName, "baseName");
      return (
        baseName.name === "Typewriter" || baseName.namePath === "Typewriter"
      );
    });
  });

  if (typewriterContracts.length === 0) {
    throw new Error(
      `${basename(entrypoint)} does not contain a contract inheriting Typewriter`,
    );
  }
  if (typewriterContracts.length > 1) {
    throw new Error(
      `${basename(entrypoint)} contains multiple contracts inheriting Typewriter: ${typewriterContracts
        .map((contract) => contract.name)
        .join(", ")}`,
    );
  }
  return typewriterContracts[0]!;
}

function collectDeclarations(asts: readonly AstNode[]): Map<number, AstNode> {
  const declarations = new Map<number, AstNode>();
  const visit = (node: AstNode) => {
    if (typeof node.id === "number") declarations.set(node.id, node);
    for (const child of asAstNodes(node.nodes)) visit(child);
    for (const member of asAstNodes(node.members)) visit(member);
  };
  for (const ast of asts) visit(ast);
  return declarations;
}

function findContractNode(
  contract: AstNode,
  nodeType: string,
  name: string,
): AstNode {
  const matches = asAstNodes(contract.nodes).filter(
    (node) => node.nodeType === nodeType && node.name === name,
  );
  if (matches.length !== 1) {
    throw new Error(
      `${contract.name ?? "entrypoint"} must define exactly one ${name} ${nodeType}`,
    );
  }
  return matches[0]!;
}

function abiTypeFromTypeName(typeName: unknown): string {
  const node = asAstNode(typeName, "typeName");
  if (node.nodeType === "ElementaryTypeName") {
    if (typeof node.name !== "string")
      throw new Error("elementary type missing name");
    return node.name;
  }
  if (node.nodeType === "UserDefinedTypeName") {
    const typeDescriptions = requireObject(
      node.typeDescriptions,
      "type descriptions",
    );
    const typeString = typeDescriptions.typeString;
    if (typeof typeString !== "string")
      throw new Error("type missing typeString");
    if (typeString.startsWith("enum ")) return "uint8";
  }
  if (node.nodeType === "ArrayTypeName") {
    const baseType = abiTypeFromTypeName(node.baseType);
    const length =
      isObject(node.length) && typeof node.length.value === "string"
        ? node.length.value
        : "";
    return `${baseType}[${length}]`;
  }
  throw new Error(
    `unsupported Solidity type at ${node.src ?? "unknown source"}`,
  );
}

function structToAbiParameters(struct: AstNode): readonly AbiParameter[] {
  return asAstNodes(struct.members).map((member) => {
    if (typeof member.name !== "string") {
      throw new Error(
        `struct member missing name at ${member.src ?? "unknown source"}`,
      );
    }
    return {
      name: member.name,
      type: abiTypeFromTypeName(member.typeName),
    } satisfies AbiParameter;
  });
}

function validateRootStorageLayout(layout: StorageLayout): StorageLayout {
  for (const label of ["accounts", "state"] as const) {
    const roots = layout.storage.filter((entry) => entry.label === label);
    if (roots.length !== 1) {
      throw new Error(
        `storage layout must contain exactly one top-level ${label} variable`,
      );
    }

    const type = layout.types[roots[0]!.type] as StorageType | undefined;
    if (
      label === "accounts" &&
      (type === undefined ||
        typeof type.key !== "string" ||
        typeof type.value !== "string")
    ) {
      throw new Error("top-level accounts storage variable must be a mapping");
    }
    if (
      label === "state" &&
      (type === undefined || !Array.isArray(type.members))
    ) {
      throw new Error("top-level state storage variable must be a struct");
    }
  }

  return layout;
}

function isIdentifier(node: unknown, name: string): boolean {
  return isObject(node) && node.nodeType === "Identifier" && node.name === name;
}

function mutationNameFromCondition(condition: AstNode): string | undefined {
  if (condition.nodeType !== "BinaryOperation" || condition.operator !== "==") {
    return undefined;
  }

  const left = condition.leftExpression;
  const right = condition.rightExpression;
  return (
    mutationNameFromComparison(left, right) ??
    mutationNameFromComparison(right, left)
  );
}

function mutationNameFromComparison(
  mutationExpression: unknown,
  enumExpression: unknown,
): string | undefined {
  if (isMutationCast(mutationExpression) && isMutationMember(enumExpression)) {
    return (enumExpression as AstNode).memberName as string;
  }
  if (
    isIdentifier(mutationExpression, "mutation") &&
    isUint8MutationMember(enumExpression)
  ) {
    const args = asAstNodes((enumExpression as AstNode).arguments);
    return (args[0] as AstNode).memberName as string;
  }
  return undefined;
}

function isMutationCast(node: unknown): boolean {
  if (!isObject(node) || node.nodeType !== "FunctionCall") return false;
  if (node.kind !== "typeConversion") return false;
  if (!isIdentifier(node.expression, "Mutation")) return false;
  const args = asAstNodes(node.arguments);
  return args.length === 1 && isIdentifier(args[0], "mutation");
}

function isMutationMember(node: unknown): boolean {
  return (
    isObject(node) &&
    node.nodeType === "MemberAccess" &&
    isIdentifier(node.expression, "Mutation") &&
    typeof node.memberName === "string"
  );
}

function isUint8MutationMember(node: unknown): boolean {
  if (!isObject(node) || node.nodeType !== "FunctionCall") return false;
  if (node.kind !== "typeConversion") return false;
  if (!isUint8TypeExpression(node.expression)) return false;
  const args = asAstNodes(node.arguments);
  return args.length === 1 && isMutationMember(args[0]);
}

function isUint8TypeExpression(node: unknown): boolean {
  if (isIdentifier(node, "uint8")) return true;
  if (!isObject(node) || node.nodeType !== "ElementaryTypeNameExpression") {
    return false;
  }
  const typeName = node.typeName;
  return isObject(typeName) && typeName.name === "uint8";
}

function flattenDispatchBranches(statement: AstNode): readonly {
  readonly name: string;
  readonly body: AstNode;
}[] {
  if (statement.nodeType !== "IfStatement") return [];
  const name = mutationNameFromCondition(
    asAstNode(statement.condition, "if condition"),
  );
  const branches =
    name === undefined
      ? []
      : [{ name, body: asAstNode(statement.trueBody, "if trueBody") }];
  const falseBody = statement.falseBody;
  if (isObject(falseBody) && falseBody.nodeType === "IfStatement") {
    return [...branches, ...flattenDispatchBranches(falseBody as AstNode)];
  }
  return branches;
}

function isAbiDecodeOf(initialValue: unknown, dataName: string): boolean {
  if (!isObject(initialValue) || initialValue.nodeType !== "FunctionCall")
    return false;
  const expression = initialValue.expression;
  if (!isObject(expression) || expression.nodeType !== "MemberAccess")
    return false;
  if (expression.memberName !== "decode") return false;
  if (!isIdentifier(expression.expression, "abi")) return false;
  const args = asAstNodes(initialValue.arguments);
  return args.length >= 1 && isIdentifier(args[0], dataName);
}

function declarationStructId(statement: AstNode): number | undefined {
  const declarations = asAstNodes(statement.declarations);
  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0]!;
  const typeName = declaration.typeName;
  if (!isObject(typeName)) return undefined;
  return typeof typeName.referencedDeclaration === "number"
    ? typeName.referencedDeclaration
    : undefined;
}

function findDecodeStructIds(
  body: AstNode,
  dataName: string,
): readonly number[] {
  return asAstNodes(body.statements).flatMap((statement) => {
    if (statement.nodeType !== "VariableDeclarationStatement") return [];
    if (!isAbiDecodeOf(statement.initialValue, dataName)) return [];
    const id = declarationStructId(statement);
    return id === undefined ? [] : [id];
  });
}

function parseMutations(params: {
  readonly contract: AstNode;
  readonly declarations: Map<number, AstNode>;
}): readonly ParsedMutation[] {
  const mutationEnum = findContractNode(
    params.contract,
    "EnumDefinition",
    "Mutation",
  );
  const enumMembers = asAstNodes(mutationEnum.members).map((member, id) => {
    if (typeof member.name !== "string") {
      throw new Error(
        `Mutation enum member missing name at ${member.src ?? "unknown source"}`,
      );
    }
    if (Object.hasOwn(BUILTIN_MUTATIONS, member.name)) {
      throw new Error(`Mutation.${member.name} is reserved by Typewriter`);
    }
    if (id >= 253) {
      throw new Error(
        `Mutation.${member.name} has reserved mutation ID ${id}; app mutation IDs must be below 253`,
      );
    }
    return { enumName: member.name, id };
  });
  const dispatch = findContractNode(
    params.contract,
    "FunctionDefinition",
    "dispatch",
  );
  const body = asAstNode(dispatch.body, "dispatch body");
  const firstStatement = asAstNodes(body.statements)[0];
  if (firstStatement === undefined)
    throw new Error("dispatch must contain mutation branches");
  const branches = new Map(
    flattenDispatchBranches(firstStatement).map((branch) => [
      branch.name,
      branch.body,
    ]),
  );

  return enumMembers.map((member) => {
    const branch = branches.get(member.enumName);
    if (branch === undefined) {
      throw new Error(
        `dispatch missing branch for Mutation.${member.enumName}`,
      );
    }
    const mutationStructIds = findDecodeStructIds(branch, "mutationData");
    if (mutationStructIds.length !== 1) {
      throw new Error(
        `Mutation.${member.enumName} must decode mutationData exactly once`,
      );
    }
    const mutationStruct = params.declarations.get(mutationStructIds[0]!);
    if (mutationStruct?.nodeType !== "StructDefinition") {
      throw new Error(
        `Mutation.${member.enumName} decode target is not a struct`,
      );
    }
    return {
      enumName: member.enumName,
      id: member.id,
      params: structToAbiParameters(mutationStruct),
    };
  });
}

function mergeSolidityConfig<sequencingConfig extends SequencingConfig>(
  baseConfig: TypewriterConfig<sequencingConfig>,
  metadata: ParsedSolidityMetadata,
): InternalApp {
  const mutations: Record<string, ResolvedTypewriterMutationConfig> = {};

  for (const mutation of metadata.mutations) {
    mutations[mutation.enumName] = {
      id: mutation.id,
      params: mutation.params,
    };
  }

  return buildInternalApp({
    config: baseConfig,
    abi: metadata.abi,
    storageLayout: metadata.storageLayout,
    mutations,
  });
}

function solidityDeclarationMetadata(metadata: ParsedSolidityMetadata): {
  readonly storageLayout: StorageLayout;
  readonly mutations: Record<
    string,
    { readonly id: number; readonly params: readonly AbiParameter[] }
  >;
} {
  return {
    storageLayout: metadata.storageLayout,
    mutations: Object.fromEntries(
      metadata.mutations.map((mutation) => [
        mutation.enumName,
        { id: mutation.id, params: mutation.params },
      ]),
    ),
  };
}

export function formatSolidityDeclaration(
  metadata: ParsedSolidityMetadata,
): string {
  const metadataLiteral = typeLiteralForValue(
    solidityDeclarationMetadata(metadata),
    0,
  );
  return `// Generated by typewriter from ${metadata.contractName}.sol. Do not edit by hand.

declare const entrypoint: import("typewriter").TypewriterSolidityEntrypoint<${metadataLiteral}>;
export default entrypoint;
`;
}

async function findPackageRoot(path: string): Promise<string | undefined> {
  let current = dirname(path);
  while (true) {
    if (await fileExists(joinPath(current, "package.json"))) return current;

    const next = dirname(current);
    if (next === current || current === "") return undefined;
    current = next;
  }
}

async function writeIfChanged(path: string, contents: string): Promise<void> {
  const existing = Bun.file(path);
  if ((await existing.exists()) && (await existing.text()) === contents) return;
  await Bun.write(path, contents);
}

async function maybeWriteAppSolidityDeclaration(
  entrypoint: string,
  metadata: ParsedSolidityMetadata,
): Promise<void> {
  const packageRoot = await findPackageRoot(entrypoint);
  if (packageRoot === undefined) return;

  const appDeclaration = joinPath(packageRoot, "src", "typewriter.d.ts");
  if (!(await fileExists(appDeclaration))) return;

  const outputPath = `${entrypoint}.d.ts`;
  await writeIfChanged(outputPath, formatSolidityDeclaration(metadata));
}

async function requireEntrypointPath(
  entrypoint: TypewriterSolidityEntrypoint,
): Promise<string> {
  // `entrypoint` is typed as a string, but apps reach this with `as any` casts
  // around the Solidity import, so the type guarantee can be gone at runtime.
  const value = entrypoint as unknown;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      "Typewriter entrypoint must be a Solidity file path string; import the contract's .sol file and pass it as the first argument",
    );
  }
  if (!(await fileExists(value))) {
    throw new Error(
      `Typewriter entrypoint file does not exist: ${displayPath(value)}`,
    );
  }
  return value;
}

export async function parseSolidityMetadata(
  rawEntrypoint: TypewriterSolidityEntrypoint,
): Promise<ParsedSolidityMetadata> {
  const entrypoint = await requireEntrypointPath(rawEntrypoint);
  const project = await findFoundryProject(entrypoint);
  await buildFoundryProject(project);
  const entrypointAst = await readEntrypointAst(project, entrypoint);
  const contract = findEntrypointContract(entrypoint, entrypointAst);
  if (typeof contract.name !== "string")
    throw new Error("entrypoint contract missing name");

  const artifactPath = joinPath(
    project.root,
    project.out,
    basename(entrypoint),
    `${contract.name}.json`,
  );
  const artifact = await readArtifact(artifactPath);
  const abi = requireArtifactAbi(artifact, artifactPath);
  if (artifact.storageLayout === undefined) {
    throw new Error(
      `missing storage layout for ${contract.name}; ensure the Foundry profile emits storageLayout`,
    );
  }

  const asts = await readReachableSourceAsts(project, entrypointAst);
  const declarations = collectDeclarations(asts);
  const appMutations = parseMutations({ contract, declarations });
  const builtinMutations = Object.entries(BUILTIN_MUTATIONS).map(
    ([enumName, mutation]) => ({
      enumName,
      id: mutation.id,
      params: mutation.params,
    }),
  );

  return {
    contractName: contract.name,
    abi,
    storageLayout: validateRootStorageLayout(artifact.storageLayout),
    mutations: [...appMutations, ...builtinMutations],
  };
}

export async function loadSolidityTypewriterApp<
  sequencingConfig extends SequencingConfig,
>(
  entrypoint: TypewriterSolidityEntrypoint,
  config: TypewriterConfig<sequencingConfig>,
): Promise<InternalApp> {
  const metadata = await parseSolidityMetadata(entrypoint);
  const entrypointPath = await requireEntrypointPath(entrypoint);
  await maybeWriteAppSolidityDeclaration(entrypointPath, metadata);
  return mergeSolidityConfig(config, metadata);
}
