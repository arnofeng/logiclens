import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { x as extractTarball } from "tar";

type PackageJson = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  files?: string[];
  engines?: { node?: string };
  publishConfig?: { access?: string };
};

type PackageTarget = {
  directory: string;
  packageJson: PackageJson;
  allowSource: boolean;
};

const root = process.cwd();
const expectedNodeEngine = ">=20.19.0";
const pluginApiKey = "logic" + "lensPluginApiVersion";
const pluginApiExport = "LOGIC" + "LENS_PLUGIN_API_VERSION";
const packageDirectories = [
  ".",
  "packages/plugin-sdk",
  "packages/plugin-csharp"
] as const;

async function main(): Promise<void> {
  const targets = await Promise.all(packageDirectories.map(loadTarget));
  const rootTarget = targets[0];
  const expectedVersion = rootTarget.packageJson.version;
  const expectedNames = new Set(targets.map((target) => target.packageJson.name));

  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(expectedVersion), `Invalid release version: ${expectedVersion}`);
  for (const target of targets) {
    assert(target.packageJson.version === expectedVersion, `${target.packageJson.name} version ${target.packageJson.version} does not match ${expectedVersion}`);
    assert(target.packageJson.engines?.node === expectedNodeEngine, `${target.packageJson.name} must require Node.js ${expectedNodeEngine}`);
    assert(target.packageJson.publishConfig?.access === "public", `${target.packageJson.name} must publish with public access`);
  }

  const sdk = targets.find((target) => target.directory === "packages/plugin-sdk");
  const csharp = targets.find((target) => target.directory === "packages/plugin-csharp");
  assert(sdk && csharp, "Release package set is incomplete");

  assert(rootTarget.packageJson.dependencies?.[sdk.packageJson.name] === "workspace:*", "Root SDK dependency must use workspace:*");
  assert(csharp.packageJson.dependencies?.[sdk.packageJson.name] === "workspace:*", "C# SDK dependency must use workspace:*");

  const pluginManifest = JSON.parse(await fs.readFile(path.join(root, "packages/plugin-csharp/plugin.json"), "utf8")) as {
    name: string;
    version: string;
  } & Record<string, unknown>;
  assert(pluginManifest.name === csharp.packageJson.name, "C# plugin manifest name does not match package.json");
  assert(pluginManifest.version === expectedVersion, "C# plugin manifest version does not match package.json");
  assert(pluginManifest[pluginApiKey] === "1.0.0", "C# plugin must target Plugin API 1.0.0");

  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${rootTarget.packageJson.name}-release-check-`));
  try {
    for (const target of targets) {
      await verifyPackedPackage(target, expectedVersion, expectedNames, outputRoot);
    }

    const sdkModule = await import(pathToFileURL(path.join(root, "packages/plugin-sdk/dist/index.js")).href);
    assert(sdkModule[pluginApiExport] === "1.0.0", "Built SDK Plugin API version must be 1.0.0");

    const csharpModule = await import(pathToFileURL(path.join(root, "packages/plugin-csharp/dist/index.js")).href);
    assert(csharpModule.default?.manifest?.version === expectedVersion, "Built C# plugin version does not match package.json");
    assert(csharpModule.default?.manifest?.[pluginApiKey] === "1.0.0", "Built C# plugin API version must be 1.0.0");
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }

  console.log(`Release package validation passed for ${expectedVersion}: ${[...expectedNames].join(", ")}`);
}

async function loadTarget(directory: string): Promise<PackageTarget> {
  const packageJson = JSON.parse(await fs.readFile(path.join(root, directory, "package.json"), "utf8")) as PackageJson;
  return { directory, packageJson, allowSource: false };
}

async function verifyPackedPackage(
  target: PackageTarget,
  expectedVersion: string,
  expectedNames: ReadonlySet<string>,
  outputRoot: string
): Promise<void> {
  const destination = path.join(outputRoot, target.packageJson.name.replace(/[^a-zA-Z0-9.-]+/gu, "-"));
  await fs.mkdir(destination, { recursive: true });
  runPnpm(["--dir", target.directory, "pack", "--pack-destination", destination, "--silent"]);

  const tarballs = (await fs.readdir(destination)).filter((entry) => entry.endsWith(".tgz"));
  assert(tarballs.length === 1, `${target.packageJson.name} produced ${tarballs.length} tarballs`);

  const extraction = path.join(destination, "extracted");
  await fs.mkdir(extraction);
  await extractTarball({ file: path.join(destination, tarballs[0]), cwd: extraction });
  const entries = await collectFiles(extraction);
  assert(entries.includes("package/package.json"), `${target.packageJson.name} tarball is missing package.json`);
  assert(entries.includes("package/LICENSE"), `${target.packageJson.name} tarball is missing LICENSE`);
  assert(entries.includes("package/README.md"), `${target.packageJson.name} tarball is missing README.md`);
  assert(!entries.some((entry) => entry.startsWith("package/src/")), `${target.packageJson.name} tarball contains source files`);
  assert(!entries.some((entry) => /\/tsconfig(?:\.[^/]+)?\.json$/u.test(entry)), `${target.packageJson.name} tarball contains a tsconfig`);

  const packed = JSON.parse(await fs.readFile(path.join(extraction, "package/package.json"), "utf8")) as PackageJson;
  assert(packed.version === expectedVersion, `${target.packageJson.name} packed version does not match ${expectedVersion}`);
  for (const [dependency, range] of Object.entries(packed.dependencies ?? {})) {
    assert(!range.startsWith("workspace:"), `${target.packageJson.name} leaked workspace protocol for ${dependency}`);
    if (expectedNames.has(dependency)) {
      assert(range === expectedVersion, `${target.packageJson.name} packed ${dependency} as ${range}, expected ${expectedVersion}`);
    }
  }
}

async function collectFiles(directory: string, relative = ""): Promise<string[]> {
  const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(directory, child));
    else files.push(child);
  }
  return files.sort();
}

function runPnpm(args: string[]): void {
  const pnpmScript = process.env.npm_execpath;
  const executable = pnpmScript ? process.execPath : "pnpm";
  const executableArgs = pnpmScript ? [pnpmScript, ...args] : args;
  const result = spawnSync(executable, executableArgs, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} exited with ${result.status ?? "no status"}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
