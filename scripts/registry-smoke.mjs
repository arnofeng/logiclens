import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new Error("Usage: node scripts/registry-smoke.mjs <version>");
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const sdkManifest = JSON.parse(await fs.readFile(path.join(repositoryRoot, "packages/plugin-sdk/package.json"), "utf8"));
const csharpManifest = JSON.parse(await fs.readFile(path.join(repositoryRoot, "packages/plugin-csharp/package.json"), "utf8"));
const pluginApiExport = "LOGIC" + "LENS_PLUGIN_API_VERSION";
const pluginApiKey = "logic" + "lensPluginApiVersion";
const root = await fs.mkdtemp(path.join(os.tmpdir(), `${rootManifest.name}-registry-smoke-`));
const installRoot = path.join(root, "install");
const workspace = path.join(root, "workspace");
const packageSpecs = [
  `${rootManifest.name}@${version}`,
  `${sdkManifest.name}@${version}`,
  `${csharpManifest.name}@${version}`
];

try {
  await fs.mkdir(installRoot);
  await fs.mkdir(workspace);
  await installWithRetry(packageSpecs);

  const binName = Object.keys(rootManifest.bin)[0];
  const bin = process.platform === "win32"
    ? path.join(installRoot, `node_modules/.bin/${binName}.cmd`)
    : path.join(installRoot, `node_modules/.bin/${binName}`);
  run(bin, ["--version"], workspace);
  run(bin, ["--help"], workspace);
  run(bin, ["init"], workspace);
  run(bin, ["plugin", "install", `${csharpManifest.name}@${version}`], workspace);
  run(bin, ["plugin", "doctor", "--all"], workspace);

  const host = await importPackage(rootManifest.name);
  const sdk = await importPackage(sdkManifest.name);
  const csharp = await importPackage(csharpManifest.name);
  assert(typeof host.createClient === "function", `${rootManifest.name} does not export createClient`);
  assert(sdk[pluginApiExport] === "1.0.0", "Plugin API version is not 1.0.0");
  assert(csharp.default?.manifest?.version === version, "C# plugin version does not match registry version");
  assert(csharp.default?.manifest?.[pluginApiKey] === "1.0.0", "C# plugin API version is not 1.0.0");

  console.log(`Registry smoke test passed for ${rootManifest.name} ${version} on ${process.platform} / Node ${process.version}`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

async function installWithRetry(specs) {
  let lastStatus = 1;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = spawnSync(npmExecutable(), ["install", "--prefix", installRoot, "--no-package-lock", ...specs], {
      cwd: installRoot,
      stdio: "inherit",
      shell: false
    });
    if (!result.error && result.status === 0) return;
    if (result.error) console.error(result.error.message);
    lastStatus = result.status ?? 1;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
  }
  throw new Error(`npm install failed after registry propagation retries (status ${lastStatus})`);
}

async function importPackage(name) {
  const packageJsonPath = path.join(installRoot, "node_modules", ...name.split("/"), "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const exportPath = typeof packageJson.exports?.["."]?.default === "string"
    ? packageJson.exports["."].default
    : packageJson.main;
  assert(typeof exportPath === "string", `${name} has no importable entry point`);
  return await import(pathToFileURL(path.resolve(path.dirname(packageJsonPath), exportPath)).href);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "no status"}`);
}

function npmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
