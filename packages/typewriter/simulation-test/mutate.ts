/**
 * Mutation testing: makes one small change to the runtime at a time, runs a
 * corpus of simulations against it, and reports whether any run failed.
 *
 * Usage: `DATABASE_URL=<url> bun simulation-test/mutate.ts [--files src/typewriter.ts,src/watch.ts]
 * [--sample 40] [--seed mutants] [--corpus 0x01,0x02] [--list]`
 *
 * A corpus entry is a seed, or a plan file under `simulation-test/` for
 * `--plan`. A mutant survives when every run passes. Removing a log is not a
 * mutant. Each source file is restored after its mutant.
 */
import { SQL } from "bun";
import ts from "typescript";

type Mutant = {
  file: string;
  line: number;
  operator: string;
  start: number;
  end: number;
  original: string;
  replacement: string;
};

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
const files = flag("--files", "src/typewriter.ts,src/watch.ts").split(",");
const sample = Number(flag("--sample", "40"));
const corpus = flag(
  "--corpus",
  "0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0a",
).split(",");
const seed = flag("--seed", "mutants");
const RUN_TIMEOUT_MS = 180_000;
// biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
const DATABASE_URL = process.env["DATABASE_URL"];

const SWAPS: Partial<Record<ts.SyntaxKind, ts.SyntaxKind>> = {
  [ts.SyntaxKind.LessThanToken]: ts.SyntaxKind.LessThanEqualsToken,
  [ts.SyntaxKind.LessThanEqualsToken]: ts.SyntaxKind.LessThanToken,
  [ts.SyntaxKind.GreaterThanToken]: ts.SyntaxKind.GreaterThanEqualsToken,
  [ts.SyntaxKind.GreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanToken,
  [ts.SyntaxKind.EqualsEqualsEqualsToken]:
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]:
    ts.SyntaxKind.EqualsEqualsEqualsToken,
  [ts.SyntaxKind.AmpersandAmpersandToken]: ts.SyntaxKind.BarBarToken,
  [ts.SyntaxKind.BarBarToken]: ts.SyntaxKind.AmpersandAmpersandToken,
  [ts.SyntaxKind.PlusToken]: ts.SyntaxKind.MinusToken,
  [ts.SyntaxKind.MinusToken]: ts.SyntaxKind.PlusToken,
};

function mutantsOf(file: string, text: string): Mutant[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const mutants: Mutant[] = [];
  const add = (
    node: ts.Node,
    operator: string,
    replacement: string,
    start = node.getStart(source),
    end = node.getEnd(),
  ) =>
    mutants.push({
      file,
      line: source.getLineAndCharacterOfPosition(start).line + 1,
      operator,
      start,
      end,
      original: text.slice(start, end),
      replacement,
    });

  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node)) {
      const swap = SWAPS[node.operatorToken.kind];
      const isString = [node.left, node.right].some(
        (side) => ts.isStringLiteral(side) || ts.isTemplateExpression(side),
      );
      if (swap !== undefined && !isString) {
        add(
          node.operatorToken,
          "operator",
          ts.tokenToString(swap)!,
          node.operatorToken.getStart(source),
        );
      }
    } else if (
      (node.kind === ts.SyntaxKind.TrueKeyword ||
        node.kind === ts.SyntaxKind.FalseKeyword) &&
      !ts.isLiteralTypeNode(node.parent)
    ) {
      add(
        node,
        "boolean",
        node.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true",
      );
    } else if (ts.isIfStatement(node)) {
      add(
        node.expression,
        "negate-if",
        `!(${node.expression.getText(source)})`,
      );
    } else if (
      ts.isExpressionStatement(node) &&
      ts.isYieldExpression(node.expression) &&
      node.expression.asteriskToken !== undefined &&
      !/^yield\* Effect\.log/.test(node.getText(source))
    ) {
      add(node, "drop-yield", ";");
    } else if (
      (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) &&
      ts.isVariableDeclaration(node.parent) &&
      node.parent.initializer === node
    ) {
      const isBigInt = ts.isBigIntLiteral(node);
      const value = BigInt(node.text.replace(/n$/, "").replace(/_/g, ""));
      add(node, "constant", `${value + 1n}${isBigInt ? "n" : ""}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return mutants;
}

/** Runs one corpus entry. Returns why it failed, or `undefined` if it passed. */
async function simulate(entry: string): Promise<string | undefined> {
  const command = entry.startsWith("0x")
    ? ["bun", "simulation-test/index.ts"]
    : ["bun", "simulation-test/index.ts", "--plan", `simulation-test/${entry}`];
  const child = Bun.spawn(command, {
    env: entry.startsWith("0x") ? { ...process.env, SEED: entry } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  if (code === 0) return undefined;
  const output = `${stdout}\n${stderr}`;
  // A failed run keeps its database for inspection, which a mutant's does not need.
  const kept = /Kept simulation database database=(\S+)/.exec(output)?.[1];
  if (kept !== undefined) {
    const admin = new SQL({ url: DATABASE_URL, max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${kept}" WITH (FORCE)`);
    await admin.close();
  }
  if (child.signalCode !== null) return `timed out after ${RUN_TIMEOUT_MS}ms`;
  const lines = output.split("\n");
  const failed = lines.findIndex((line) => line.includes("Failed simulation"));
  return (lines[failed + 1] ?? lines.at(-1) ?? "").trim().slice(0, 160);
}

/** Runs the corpus in order. Returns the first failure. */
async function runCorpus() {
  for (const entry of corpus) {
    const reason = await simulate(entry);
    if (reason !== undefined) return { entry, reason };
  }
  return undefined;
}

const originals = new Map(
  await Promise.all(
    files.map(async (file) => [file, await Bun.file(file).text()] as const),
  ),
);
const all = files.flatMap((file) => mutantsOf(file, originals.get(file)!));
// A seeded order, so the same `--seed` picks the same sample.
const chosen = all
  .map((m) => ({
    m,
    key: Bun.hash(`${seed}:${m.file}:${m.start}:${m.operator}`),
  }))
  .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  .slice(0, sample)
  .map(({ m }) => m);

if (args.includes("--list")) {
  for (const m of all) console.log(describe(m));
  console.log(`${all.length} mutants`);
  process.exit(0);
}

const restore = () => {
  for (const [file, text] of originals) Bun.write(file, text);
};
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

const baseline = await runCorpus();
if (baseline !== undefined) {
  console.error(
    `The corpus fails without mutants, on ${baseline.entry}: ${baseline.reason}`,
  );
  process.exit(1);
}
console.log(
  `${all.length} mutants in ${files.join(", ")}; running ${chosen.length} against ${corpus.length} runs`,
);

function describe(m: Mutant) {
  return `${m.file}:${m.line} ${m.operator} ${JSON.stringify(m.original.slice(0, 60))} -> ${JSON.stringify(m.replacement.slice(0, 60))}`;
}

const results: {
  mutant: Mutant;
  killedBy?: { entry: string; reason: string };
}[] = [];
for (const [i, mutant] of chosen.entries()) {
  const text = originals.get(mutant.file)!;
  await Bun.write(
    mutant.file,
    text.slice(0, mutant.start) + mutant.replacement + text.slice(mutant.end),
  );
  let killedBy: { entry: string; reason: string } | undefined;
  try {
    killedBy = await runCorpus();
  } finally {
    await Bun.write(mutant.file, text);
  }
  results.push({ mutant, killedBy });
  const where = describe(mutant);
  console.log(
    `[${i + 1}/${chosen.length}] ${killedBy === undefined ? "SURVIVED" : "killed  "} ${where}${killedBy === undefined ? "" : ` by ${killedBy.entry}: ${killedBy.reason}`}`,
  );
}

const killed = results.filter(({ killedBy }) => killedBy !== undefined).length;
console.log(
  `score: ${killed}/${results.length} killed (${Math.round((100 * killed) / Math.max(results.length, 1))}%)`,
);
