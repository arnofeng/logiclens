import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = realpathSync(process.cwd()).replace(/^[a-z]:/, (match) => match.toUpperCase());
const vitestBin = path.join(root, "node_modules", "vitest", "vitest.mjs");
const baseArgs = ["vitest", "run", "--pool", "forks", "--maxWorkers=1", "--reporter", "verbose"];

function collectTestFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectTestFiles(fullPath);
    if (!entry.name.endsWith(".test.ts")) return [];
    return [path.relative(root, fullPath).replace(/\\/g, "/")];
  });
}

function runVitest(args: string[]): void {
  const nodeArgs = [vitestBin, ...args.slice(1)];
  console.log(`\n> node ${path.relative(root, vitestBin).replace(/\\/g, "/")} ${args.slice(1).join(" ")}`);
  const result = spawnSync(process.execPath, nodeArgs, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const packageTestDirectories = readdirSync(path.join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(root, "packages", entry.name, "tests"))
  .filter(existsSync);

const testFiles = [path.join(root, "tests"), ...packageTestDirectories]
  .flatMap(collectTestFiles)
  .filter((file) => file !== "tests/bulkWriter.test.ts")
  .sort();

for (const file of testFiles) {
  runVitest([...baseArgs, file]);
}

runVitest([...baseArgs, "tests/bulkWriter.test.ts", "-t", "imports a fixture graph"]);
runVitest([...baseArgs, "tests/bulkWriter.test.ts", "-t", "upserts a fixture graph"]);
