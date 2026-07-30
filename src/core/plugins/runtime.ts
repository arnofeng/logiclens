import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  LOGICLENS_PLUGIN_API_VERSION,
  type LogicLensPlugin,
  type PluginCapability,
  type PluginManifest,
  type PluginManifestLanguage
} from "@logiclens/plugin-sdk";

export type PluginRuntimeOptions = {
  cwd?: string;
  failFast?: boolean;
  onWarning?: (message: string) => void;
};

export type LoadedLogicLensPlugin = {
  plugin: LogicLensPlugin;
  source: string;
};

export type DiscoveredLogicLensPlugin = {
  manifest: PluginManifest;
  source: string;
  baseDir: string;
  entryPath: string;
};

const SUPPORTED_API_MAJOR = majorOf(LOGICLENS_PLUGIN_API_VERSION);

export async function loadLogicLensPlugins(
  pluginSpecifiers: readonly string[],
  options: PluginRuntimeOptions = {}
): Promise<LoadedLogicLensPlugin[]> {
  const loaded: LoadedLogicLensPlugin[] = [];
  for (const specifier of pluginSpecifiers) {
    try {
      const plugin = await importPlugin(specifier, options.cwd ?? process.cwd());
      validatePlugin(plugin, specifier);
      loaded.push({ plugin, source: specifier });
    } catch (error) {
      const message = `Failed to load LogicLens plugin "${specifier}": ${error instanceof Error ? error.message : String(error)}`;
      if (options.failFast) throw new Error(message);
      options.onWarning?.(message);
    }
  }
  return loaded;
}

export async function discoverLogicLensPlugin(
  pluginDir: string,
  source = pluginDir
): Promise<DiscoveredLogicLensPlugin> {
  const baseDir = path.resolve(pluginDir);
  const manifestPath = path.join(baseDir, "plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as PluginManifest;
  validateManifest(manifest, source);
  const entryPath = await resolvePluginEntry(baseDir, manifest);
  return { manifest, source, baseDir, entryPath };
}

export async function discoverLogicLensPlugins(
  pluginDirs: readonly string[],
  options: PluginRuntimeOptions = {}
): Promise<DiscoveredLogicLensPlugin[]> {
  const discovered: DiscoveredLogicLensPlugin[] = [];
  for (const pluginDir of pluginDirs) {
    try {
      discovered.push(await discoverLogicLensPlugin(path.resolve(options.cwd ?? process.cwd(), pluginDir), pluginDir));
    } catch (error) {
      const message = `Failed to discover LogicLens plugin "${pluginDir}": ${error instanceof Error ? error.message : String(error)}`;
      if (options.failFast) throw new Error(message);
      options.onWarning?.(message);
    }
  }
  return discovered;
}

export async function loadDiscoveredLogicLensPlugins(
  plugins: readonly DiscoveredLogicLensPlugin[],
  options: PluginRuntimeOptions = {}
): Promise<LoadedLogicLensPlugin[]> {
  const loaded: LoadedLogicLensPlugin[] = [];
  for (const discovered of plugins) {
    try {
      const plugin = await importPlugin(discovered.entryPath, options.cwd ?? process.cwd());
      validatePlugin(plugin, discovered.source, discovered.manifest);
      loaded.push({ plugin, source: discovered.source });
    } catch (error) {
      const message = `Failed to load LogicLens plugin "${discovered.source}": ${error instanceof Error ? error.message : String(error)}`;
      if (options.failFast) throw new Error(message);
      options.onWarning?.(message);
    }
  }
  return loaded;
}

export function validatePlugin(plugin: unknown, source = "<plugin>", expectedManifest?: PluginManifest): asserts plugin is LogicLensPlugin {
  if (!plugin || typeof plugin !== "object") {
    throw new Error(`${source} did not export a plugin object.`);
  }
  const candidate = plugin as Partial<LogicLensPlugin>;
  const manifest = candidate.manifest;
  validateManifest(manifest, source);
  if (expectedManifest) validateManifestConsistency(manifest, expectedManifest, source);
  requireCapabilityPayload(candidate, "language", candidate.languages, source);
  requireCapabilityPayload(candidate, "fact-extractor", candidate.factExtractors, source);
  requireCapabilityPayload(candidate, "framework-detector", candidate.frameworkDetectors, source);
  requireCapabilityPayload(candidate, "resolver", candidate.resolvers, source);
  validateExportedLanguages(candidate, manifest, source);
}

async function importPlugin(specifier: string, cwd: string): Promise<LogicLensPlugin> {
  const moduleSpecifier = isPathSpecifier(specifier)
    ? pathToFileURL(path.resolve(cwd, specifier)).href
    : specifier;
  const moduleValue = await import(moduleSpecifier) as { default?: unknown; plugin?: unknown };
  return (moduleValue.default ?? moduleValue.plugin ?? moduleValue) as LogicLensPlugin;
}

function validateManifest(manifest: unknown, source: string): asserts manifest is PluginManifest {
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`${source} is missing manifest.`);
  }
  const candidate = manifest as Partial<PluginManifest>;
  if (!candidate.name || !candidate.version || !candidate.logiclensPluginApiVersion) {
    throw new Error(`${source} manifest must include name, version, and logiclensPluginApiVersion.`);
  }
  if (!Array.isArray(candidate.capabilities)) {
    throw new Error(`${source} manifest capabilities must be an array.`);
  }
  for (const capability of candidate.capabilities) {
    if (!isKnownCapability(capability)) {
      throw new Error(`${source} declares unknown capability "${String(capability)}".`);
    }
  }
  if (majorOf(candidate.logiclensPluginApiVersion) !== SUPPORTED_API_MAJOR) {
    throw new Error(
      `${source} requires plugin API ${candidate.logiclensPluginApiVersion}, ` +
      `but this runtime supports ${LOGICLENS_PLUGIN_API_VERSION}.`
    );
  }
  if (candidate.capabilities.includes("language")) {
    if (!Array.isArray(candidate.languages) || candidate.languages.length === 0) {
      throw new Error(`${source} declares "language" but manifest.languages is missing or empty.`);
    }
  }
  if (candidate.languages !== undefined) {
    if (!Array.isArray(candidate.languages)) {
      throw new Error(`${source} manifest.languages must be an array.`);
    }
    for (const language of candidate.languages) validateManifestLanguage(language, source);
  }
}

function validateManifestLanguage(language: unknown, source: string): asserts language is PluginManifestLanguage {
  if (!language || typeof language !== "object") {
    throw new Error(`${source} manifest language entries must be objects.`);
  }
  const candidate = language as Partial<PluginManifestLanguage>;
  if (!candidate.id || !Array.isArray(candidate.extensions) || candidate.extensions.length === 0) {
    throw new Error(`${source} manifest language entries must include id and non-empty extensions.`);
  }
  if (candidate.requiresLanguages !== undefined && !Array.isArray(candidate.requiresLanguages)) {
    throw new Error(`${source} manifest language "${candidate.id}" requiresLanguages must be an array.`);
  }
}

async function resolvePluginEntry(baseDir: string, manifest: PluginManifest): Promise<string> {
  if (manifest.entry) {
    return requireFile(path.resolve(baseDir, manifest.entry), `${manifest.name} manifest.entry`);
  }
  const packageJsonPath = path.join(baseDir, "package.json");
  let packageJson: any;
  try {
    packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  } catch {
    throw new Error(`${manifest.name} must define manifest.entry or package.json exports/main.`);
  }

  const candidate = entryFromPackageJson(packageJson);
  if (!candidate) {
    throw new Error(`${manifest.name} package.json must define exports["."].import/default, module, or main.`);
  }
  return requireFile(path.resolve(baseDir, candidate), `${manifest.name} package entry`);
}

function entryFromPackageJson(packageJson: any): string | undefined {
  const exportsRoot = packageJson?.exports?.["."] ?? packageJson?.exports;
  if (typeof exportsRoot === "string") return exportsRoot;
  if (exportsRoot && typeof exportsRoot === "object") {
    const value = exportsRoot.import ?? exportsRoot.default;
    if (typeof value === "string") return value;
  }
  if (typeof packageJson?.module === "string") return packageJson.module;
  if (typeof packageJson?.main === "string") return packageJson.main;
  return undefined;
}

async function requireFile(filePath: string, label: string): Promise<string> {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat || !stat.isFile()) {
    throw new Error(`${label} must resolve to a concrete file: ${filePath}`);
  }
  return filePath;
}

function isPathSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(specifier);
}

function majorOf(version: string): number {
  const major = Number(version.split(".")[0]);
  return Number.isFinite(major) ? major : -1;
}

function isKnownCapability(value: unknown): value is PluginCapability {
  return value === "language" ||
    value === "fact-extractor" ||
    value === "framework-detector" ||
    value === "resolver";
}

function requireCapabilityPayload(
  plugin: Partial<LogicLensPlugin>,
  capability: PluginCapability,
  value: unknown,
  source: string
): void {
  if (!plugin.manifest?.capabilities.includes(capability)) return;
  if (!Array.isArray(value)) {
    throw new Error(`${source} declares "${capability}" but does not provide a matching array.`);
  }
}

function validateManifestConsistency(actual: PluginManifest, expected: PluginManifest, source: string): void {
  if (actual.name !== expected.name) {
    throw new Error(`${source} exported manifest name "${actual.name}" does not match plugin.json "${expected.name}".`);
  }
  if (actual.version !== expected.version) {
    throw new Error(`${source} exported manifest version "${actual.version}" does not match plugin.json "${expected.version}".`);
  }
  const actualCapabilities = [...actual.capabilities].sort();
  const expectedCapabilities = [...expected.capabilities].sort();
  if (actualCapabilities.join("\0") !== expectedCapabilities.join("\0")) {
    throw new Error(`${source} exported manifest capabilities do not match plugin.json.`);
  }
  compareManifestLanguages(actual.languages ?? [], expected.languages ?? [], source, "exported manifest");
}

function validateExportedLanguages(plugin: Partial<LogicLensPlugin>, manifest: PluginManifest, source: string): void {
  if (!manifest.capabilities.includes("language")) return;
  compareManifestLanguages(plugin.languages ?? [], manifest.languages ?? [], source, "exported plugin.languages");
}

function compareManifestLanguages(
  actual: readonly { id: string; extensions: readonly string[] }[],
  expected: readonly { id: string; extensions: readonly string[] }[],
  source: string,
  label: string
): void {
  const normalize = (items: readonly { id: string; extensions: readonly string[] }[]) =>
    items
      .map((language) => ({
        id: language.id,
        extensions: language.extensions.map(normalizeExtension).sort()
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  const actualLanguages = normalize(actual);
  const expectedLanguages = normalize(expected);
  if (JSON.stringify(actualLanguages) !== JSON.stringify(expectedLanguages)) {
    throw new Error(`${source} ${label} languages must exactly match plugin.json manifest.languages.`);
  }
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}
