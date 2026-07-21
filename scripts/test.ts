import { existsSync, readdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const TEST_SUITES = Object.freeze({
  "retrieval-release": Object.freeze([
    "tests/kuzuLexicalLifecycle.test.ts",
    "tests/kuzuWorkspaceLexicalSpike.test.ts",
    "tests/lexicalContracts.test.ts",
    "tests/providerLexicalConformance.test.ts",
    "tests/retrieval/workspaceLifecycleConformance.test.ts",
    "tests/retrievalProviderContracts.test.ts",
    "tests/workspaceAskRetrieval.test.ts",
    "tests/workspaceRetrievalQuality.test.ts",
    "tests/workspaceUnifiedRetrieval.e2e.test.ts",
  ]),
  "neo4j-integration": Object.freeze([
    "tests/neo4jLexicalLifecycle.test.ts",
    "tests/neo4jTestEnvironment.test.ts",
    "tests/neo4jWorkspaceLexicalSpike.test.ts",
    "tests/neo4jWorkspaceUnifiedRetrieval.e2e.test.ts",
    "tests/retrieval/neo4jWorkspaceLifecycleConformance.test.ts",
  ]),
} as const);

export type TestSuiteName = keyof typeof TEST_SUITES | "all";

function normalizedRoot(directory: string): string {
  return realpathSync(directory).replace(/^[a-z]:/u, (match) => match.toUpperCase());
}

function collectTestFiles(root: string, directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTestFiles(root, fullPath);
    if (!entry.name.endsWith(".test.ts")) return [];
    return [path.relative(root, fullPath).replace(/\\/gu, "/")];
  });
}

export function collectAllTestFiles(directory = process.cwd()): string[] {
  const root = normalizedRoot(directory);
  const packageTestDirectories = readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, "packages", entry.name, "tests"))
    .filter(existsSync);
  return [path.join(root, "tests"), ...packageTestDirectories]
    .flatMap((testDirectory) => collectTestFiles(root, testDirectory))
    .sort();
}

export function filesForSuite(suite: TestSuiteName, directory = process.cwd()): readonly string[] {
  if (suite === "all") return collectAllTestFiles(directory);
  return TEST_SUITES[suite];
}

function parseSuite(args: readonly string[]): TestSuiteName {
  const suiteIndex = args.indexOf("--suite");
  if (suiteIndex < 0) return "all";
  const value = args[suiteIndex + 1];
  if (value === "all" || value === "retrieval-release" || value === "neo4j-integration") return value;
  throw new Error(`Unknown test suite: ${value ?? "<missing>"}.`);
}

function runVitest(root: string, vitestBin: string, args: string[]): void {
  const nodeArgs = [vitestBin, ...args];
  console.log(`\n> node ${path.relative(root, vitestBin).replace(/\\/gu, "/")} ${args.join(" ")}`);
  const result = spawnSync(process.execPath, nodeArgs, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function runTestSuite(suite: TestSuiteName, directory = process.cwd()): void {
  const root = normalizedRoot(directory);
  const vitestBin = path.join(root, "node_modules", "vitest", "vitest.mjs");
  const baseArgs = ["run", "--pool", "forks", "--maxWorkers=1", "--reporter", "verbose"];
  const files = filesForSuite(suite, root);
  const standardFiles = files.filter((file) => file !== "tests/bulkWriter.test.ts");
  for (const file of standardFiles) runVitest(root, vitestBin, [...baseArgs, file]);
  if (files.includes("tests/bulkWriter.test.ts")) {
    runVitest(root, vitestBin, [...baseArgs, "tests/bulkWriter.test.ts", "-t", "imports a fixture graph"]);
    runVitest(root, vitestBin, [...baseArgs, "tests/bulkWriter.test.ts", "-t", "upserts a fixture graph"]);
  }
}

const invokedPath = process.argv[1] ? normalizedRoot(process.argv[1]) : "";
if (invokedPath === normalizedRoot(fileURLToPath(import.meta.url))) {
  try {
    runTestSuite(parseSuite(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
