import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverLogicLensPlugin, loadDiscoveredLogicLensPlugins } from "@logiclens/plugin-runtime";
import type { AppConfig } from "../../config/schema.js";
import { BRAND } from "../../shared/branding.js";

export type ProjectPluginScope = { kind: "project"; repoName: string; root: string };
export type PluginScope = ProjectPluginScope | { kind: "global"; root: string };
export type PluginInstallSource = { kind: "directory" | "tarball" | "npm"; value: string };
export type PluginHealthStatus = "valid" | "invalid";
export type PluginInstallMetadata = { source: string; resolvedVersion: string; scope: "project" | "global"; installedAt: string };
export type InstalledPluginRecord = {
  name: string; version: string; scope: "project" | "global"; repo?: string; source?: string;
  status: PluginHealthStatus; path: string; error?: string;
};
export type CommandRunner = (command: string, args: readonly string[], options: { cwd: string }) => Promise<string>;
export type PluginManagementDependencies = { homeDir?: string; run?: CommandRunner; now?: () => Date };

const INSTALL_METADATA = `${BRAND.configDirName}-install.json`;

export function classifyPluginSource(source: string, cwd = process.cwd()): PluginInstallSource {
  const resolved = path.resolve(cwd, source);
  if (source.toLowerCase().endsWith(".tgz")) return { kind: "tarball", value: resolved };
  if (isPathLike(source) || (existsSync(resolved) && statSync(resolved).isDirectory())) return { kind: "directory", value: resolved };
  return { kind: "npm", value: source };
}

export function safePluginDirectoryName(name: string): string {
  const trimmed = name.trim();
  if (!/^(?:@[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+|[a-zA-Z0-9._-]+)$/.test(trimmed)) throw new Error(`Invalid plugin name: ${name}`);
  const safe = trimmed.replace(/^@/, "").replace("/", "+");
  if (!safe || safe === "." || safe === "..") throw new Error(`Invalid plugin name: ${name}`);
  return safe;
}

export function globalPluginScope(homeDir = os.homedir()): PluginScope {
  return { kind: "global", root: path.join(homeDir, BRAND.configDirName, "plugins") };
}

export function projectPluginScopes(config: AppConfig, cwd: string): ProjectPluginScope[] {
  return config.repos.map((repo) => ({
    kind: "project" as const, repoName: repo.name,
    root: path.join(path.resolve(cwd, repo.path), BRAND.configDirName, "plugins")
  }));
}

export function resolveProjectPluginScope(config: AppConfig, workspaceRoot: string, repoName?: string, invocationCwd = workspaceRoot): PluginScope {
  const scopes = projectPluginScopes(config, workspaceRoot);
  if (repoName) {
    const match = scopes.find((scope) => scope.repoName === repoName);
    if (!match) throw new Error(`Repository "${repoName}" is not configured.`);
    return match;
  }
  const resolvedCwd = path.resolve(invocationCwd);
  const cwdMatch = [...scopes]
    .sort((left, right) => repoRoot(right).length - repoRoot(left).length)
    .find((scope) => isPathInside(repoRoot(scope), resolvedCwd));
  if (cwdMatch) return cwdMatch;
  if (scopes.length === 1) return scopes[0]!;
  if (scopes.length === 0) throw new Error("No repositories are configured. Use --global or add a repository first.");
  throw new Error("Multiple repositories are configured; specify --repo <name> or use --global.");
}

export async function installPlugin(
  source: string, scope: PluginScope, options: { cwd?: string; force?: boolean } = {},
  dependencies: PluginManagementDependencies = {}
): Promise<InstalledPluginRecord> {
  const cwd = options.cwd ?? process.cwd();
  const input = classifyPluginSource(source, cwd);
  const run = dependencies.run ?? runCommand;
  await fs.mkdir(scope.root, { recursive: true });
  const staging = await fs.mkdtemp(path.join(scope.root, ".install-"));
  let packageDir = staging;
  try {
    if (input.kind === "directory") {
      await requireDirectory(input.value, source);
      await assertNoSymlinks(input.value);
      await fs.cp(input.value, staging, { recursive: true, force: true });
    } else if (input.kind === "tarball") {
      await requireFile(input.value, source);
      packageDir = await extractTarball(input.value, staging);
    } else {
      assertNpmPackageSpecifier(input.value);
      const packDir = await fs.mkdtemp(path.join(os.tmpdir(), `${BRAND.tempDirPrefix}-plugin-pack-`));
      try {
        const output = await runNpm(run, ["pack", input.value, "--json", "--pack-destination", packDir], cwd);
        packageDir = await extractTarball(path.join(packDir, parseNpmPackFilename(output)), staging);
      } finally { await fs.rm(packDir, { recursive: true, force: true }).catch(() => undefined); }
    }

    await validatePluginDirectoryBoundary(packageDir);
    const packageJson = await readJson(path.join(packageDir, "package.json"), true) as { dependencies?: Record<string, string> } | undefined;
    if (packageJson?.dependencies && Object.keys(packageJson.dependencies).length > 0) {
      await runNpm(run, ["install", "--omit=dev", "--no-package-lock"], packageDir);
    }
    const discovered = await discoverLogicLensPlugin(packageDir);
    await loadDiscoveredLogicLensPlugins([discovered], { cwd: packageDir, failFast: true });
    const destination = path.join(scope.root, safePluginDirectoryName(discovered.manifest.name));
    const destinationExists = await exists(destination);
    if (destinationExists) {
      if (!options.force) throw new Error(`Plugin "${discovered.manifest.name}" is already installed at ${destination}. Use --force to replace it.`);
    }
    const metadata: PluginInstallMetadata = {
      source, resolvedVersion: discovered.manifest.version, scope: scope.kind,
      installedAt: (dependencies.now ?? (() => new Date()))().toISOString()
    };
    await fs.writeFile(path.join(packageDir, INSTALL_METADATA), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    const backup = `${destination}.replace-${process.pid}-${Date.now()}`;
    if (destinationExists) await fs.rename(destination, backup);
    try {
      await fs.rename(packageDir, destination);
      if (destinationExists) await fs.rm(backup, { recursive: true, force: true });
    } catch (error) {
      if (destinationExists && await exists(backup)) await fs.rename(backup, destination);
      throw error;
    }
    return { name: discovered.manifest.name, version: discovered.manifest.version, scope: scope.kind,
      repo: scope.kind === "project" ? scope.repoName : undefined, source, status: "valid", path: destination };
  } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined); }
}

export async function inspectInstalledPlugins(
  scopes: readonly PluginScope[],
  options: { loadEntry?: boolean } = {}
): Promise<InstalledPluginRecord[]> {
  const records: InstalledPluginRecord[] = [];
  for (const scope of scopes) {
    const entries = await fs.readdir(scope.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => (item.isDirectory() || item.isSymbolicLink()) && !item.name.startsWith(".install-")).sort((a, b) => a.name.localeCompare(b.name))) {
      const pluginPath = path.join(scope.root, entry.name);
      let name = entry.name, version = "unknown", source: string | undefined, error: string | undefined;
      try {
        if (entry.isSymbolicLink()) throw new Error("Plugin installation directory must not be a symbolic link.");
        await validatePluginDirectoryBoundary(pluginPath);
        const discovered = await discoverLogicLensPlugin(pluginPath);
        name = discovered.manifest.name; version = discovered.manifest.version;
        if (options.loadEntry) await loadDiscoveredLogicLensPlugins([discovered], { cwd: pluginPath, failFast: true });
        const metadata = await readJson(path.join(pluginPath, INSTALL_METADATA), true) as PluginInstallMetadata | undefined;
        source = metadata?.source;
      } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      records.push({ name, version, scope: scope.kind, repo: scope.kind === "project" ? scope.repoName : undefined,
        source, status: error ? "invalid" : "valid", path: pluginPath, error });
    }
  }
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.name, (counts.get(record.name) ?? 0) + 1);
  for (const record of records) if ((counts.get(record.name) ?? 0) > 1) {
    record.status = "invalid";
    record.error = [record.error, `Duplicate plugin name "${record.name}" across selected scopes.`].filter(Boolean).join(" ");
  }
  return records;
}

export async function removePlugin(name: string, scope: PluginScope): Promise<string> {
  const records = await inspectInstalledPlugins([scope]);
  const match = records.find((record) => record.name === name || path.basename(record.path) === safePluginDirectoryName(name));
  if (!match) throw new Error(`Plugin "${name}" is not installed in the selected ${scope.kind} scope.`);
  await assertInside(scope.root, match.path);
  if (path.dirname(path.resolve(match.path)) !== path.resolve(scope.root)) throw new Error(`Refusing to remove a non-plugin path: ${match.path}`);
  await fs.rm(match.path, { recursive: true, force: false });
  return match.path;
}

async function extractTarball(tarball: string, staging: string): Promise<string> {
  const tar = await import("tar");
  await tar.x({ file: tarball, cwd: staging, strict: true, filter: (entryPath, entry) => {
    const normalized = entryPath.replace(/\\/g, "/");
    const entryType = "type" in entry ? entry.type : undefined;
    return !path.posix.isAbsolute(normalized) && !normalized.split("/").includes("..") && entryType !== "SymbolicLink" && entryType !== "Link";
  } });
  const packageDir = path.join(staging, "package");
  return await exists(path.join(packageDir, "plugin.json")) ? packageDir : staging;
}

async function validatePluginDirectoryBoundary(pluginDir: string): Promise<void> {
  const manifest = await readJson(path.join(pluginDir, "plugin.json"), false) as { entry?: unknown };
  let entry = manifest.entry;
  if (entry === undefined) {
    const packageJson = await readJson(path.join(pluginDir, "package.json"), true) as any;
    const rootExport = packageJson?.exports?.["."] ?? packageJson?.exports;
    entry = typeof rootExport === "string" ? rootExport
      : rootExport && typeof rootExport === "object" ? rootExport.import ?? rootExport.default
      : packageJson?.module ?? packageJson?.main;
  }
  if (typeof entry !== "string") return;
  if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) throw new Error("Plugin entry must be a relative path inside the plugin directory.");
  const entryPath = path.resolve(pluginDir, entry);
  await assertInside(pluginDir, entryPath);
  const realEntry = await fs.realpath(entryPath).catch(() => undefined);
  if (realEntry) await assertInside(await fs.realpath(pluginDir), realEntry);
}

async function assertNoSymlinks(root: string): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Plugin source contains a symbolic link: ${path.join(root, entry.name)}`);
    if (entry.isDirectory()) await assertNoSymlinks(path.join(root, entry.name));
  }
}
async function assertInside(root: string, target: string): Promise<void> {
  if (!isPathInside(path.resolve(root), path.resolve(target))) throw new Error(`Plugin path escapes its installation directory: ${target}`);
}
async function requireDirectory(value: string, label: string): Promise<void> {
  if (!(await fs.stat(value).catch(() => undefined))?.isDirectory()) throw new Error(`Plugin directory does not exist: ${label}`);
}
async function requireFile(value: string, label: string): Promise<void> {
  if (!(await fs.stat(value).catch(() => undefined))?.isFile()) throw new Error(`Plugin tarball does not exist: ${label}`);
}
async function readJson(file: string, optional: boolean): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Invalid or missing JSON file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function exists(value: string): Promise<boolean> { return Boolean(await fs.stat(value).catch(() => undefined)); }
function isPathLike(value: string): boolean { return value.startsWith(".") || value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value); }
function npmInvocation(args: readonly string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command: "npm", args: [...args] };
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) throw new Error(`Unable to locate npm-cli.js next to the Node.js executable: ${npmCli}`);
  return { command: process.execPath, args: [npmCli, ...args] };
}
function runNpm(run: CommandRunner, args: readonly string[], cwd: string): Promise<string> {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args, { cwd });
}
function repoRoot(scope: ProjectPluginScope): string { return path.dirname(path.dirname(scope.root)); }
function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
function assertNpmPackageSpecifier(value: string): void {
  if (!/^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)(?:@[a-zA-Z0-9._-]+)?$/.test(value)) {
    throw new Error(`Unsupported npm plugin specifier: ${value}. Use a package name with an optional exact version or tag.`);
  }
}
function parseNpmPackFilename(output: string): string {
  const filename = (JSON.parse(output) as Array<{ filename?: string }>)[0]?.filename;
  if (!filename || path.basename(filename) !== filename) throw new Error("npm pack did not return a safe tarball filename.");
  return filename;
}
export const runCommand: CommandRunner = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`)));
});
