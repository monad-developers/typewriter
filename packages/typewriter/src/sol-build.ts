import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { $ } from "bun";
import { Predicate } from "effect";
import { ConfigError } from "./config";
import {
  formatSolidityDeclaration,
  parseSolidity,
  type SolcOutput,
  type SolidityApp,
} from "./sol-parse";

export type TypewriterSolidityEntrypoint<metadata = unknown> = string & {
  readonly __typewriterSolidityEntrypoint?: metadata;
};

/**
 * Builds the app's Foundry project, reads the app from the compiler output,
 * and refreshes its generated declaration.
 */
export async function loadSolidityApp(
  entrypoint: TypewriterSolidityEntrypoint,
): Promise<SolidityApp> {
  // Apps cast the `.sol` import, so it may not be a path at runtime.
  const value = entrypoint as unknown;
  if (typeof value !== "string" || !(await Bun.file(value).exists())) {
    throw new ConfigError({
      message: `Typewriter entrypoint must be the path of a Solidity file, but is ${JSON.stringify(value)}; import the contract's .sol file and pass it as the first argument`,
    });
  }
  const path = resolve(value);
  const root = await findUp(dirname(path), "foundry.toml");
  if (root === undefined) {
    throw new ConfigError({
      message: `Could not find foundry.toml for ${path}`,
    });
  }

  // A new directory per build, so concurrent builds don't share artifacts.
  const dir = await mkdtemp(join(tmpdir(), "typewriter-forge-"));
  try {
    try {
      await $`forge build --ast --extra-output storageLayout --build-info --build-info-path ${join(dir, "build-info")} --out ${join(dir, "out")} --cache-path ${join(dir, "cache")}`
        .cwd(root)
        .quiet();
    } catch (cause) {
      // forge reports compiler errors on stdout and its own errors on stderr.
      const output =
        Predicate.hasProperty(cause, "stdout") &&
        Predicate.hasProperty(cause, "stderr")
          ? `${cause.stdout}${cause.stderr}`.trim()
          : "";
      throw new ConfigError({
        message: `Failed to build Foundry project ${root}${output === "" ? "" : `\n${output}`}`,
        cause,
      });
    }

    for (const file of await readdir(join(dir, "build-info"))) {
      const { output } = (await Bun.file(
        join(dir, "build-info", file),
      ).json()) as { output: SolcOutput };
      const source = Object.keys(output.sources).find(
        (source) => resolve(root, source) === path,
      );
      if (source === undefined) continue;
      const app = parseSolidity(output, source);
      // Only apps that declare `*.sol` imports read the generated types.
      const pkg = await findUp(dirname(path), "package.json");
      if (
        pkg !== undefined &&
        (await Bun.file(join(pkg, "src", "typewriter.d.ts")).exists())
      ) {
        await writeIfChanged(`${path}.d.ts`, formatSolidityDeclaration(app));
      }
      return app;
    }
    throw new ConfigError({ message: `forge did not compile ${path}` });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The nearest directory from `dir` up that contains `file`. */
async function findUp(dir: string, file: string): Promise<string | undefined> {
  if (await Bun.file(join(dir, file)).exists()) return dir;
  const parent = dirname(dir);
  return parent === dir ? undefined : findUp(parent, file);
}

async function writeIfChanged(path: string, contents: string): Promise<void> {
  const file = Bun.file(path);
  if ((await file.exists()) && (await file.text()) === contents) return;
  await Bun.write(path, contents);
}
